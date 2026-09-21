//! Recompute what a Jupiter Lend position is worth *now*.
//!
//! When a vault liquidates a tick it does not rewrite the Position accounts
//! sitting on that tick. It records the liquidation on a Branch and moves on.
//! Every position on that tick keeps its old collateral and debt in storage
//! until its owner next touches it. So reading the Position account alone
//! gives stale numbers after a liquidation.
//!
//! This module replays the steps the Jupiter read SDK does in
//! `getCurrentPositionState` / `processLiquidatedPosition`:
//!
//! 1. Find which branch liquidated this position, and the debt factor recorded at that moment (the
//!    "connection factor").
//! 2. Walk up the chain of merged branches, compounding connection factors.
//! 3. Scale the stored debt by `branch debt factor / connection factor`.
//! 4. Read collateral back out of the branch's lowest tick.

use crate::errors::LendMirrorError;
use crate::state::{JupiterTick, JupiterTickIdLiquidation};
use crate::tick_math::{self, FOUR_DECIMALS, MIN_TICK, TICK_SPACING, X30, ZERO_TICK_SCALED_RATIO};
use anchor_lang::prelude::*;

/// `Branch.status` values, from the Jupiter Vaults program.
pub const BRANCH_MERGED: u8 = 2;
pub const BRANCH_CLOSED: u8 = 3;

/// Longest chain of merged branches we will follow before giving up.
/// A real chain is a handful of hops; this only guards against a loop
/// eating the whole compute budget.
const MAX_BRANCH_HOPS: u32 = 32;

// Debt factors are not plain integers. They are packed into a u64 as
// 35 bits of coefficient followed by 15 bits of exponent:
//
//     value = coefficient * 2^(exponent - 16384)
//
// The bias means an exponent of 16384 is a factor of 1.0. Packing lets the
// vault keep a wide range in 50 bits.
const EXPONENT_BITS: u32 = 15;
const EXPONENT_MAX: u64 = (1 << EXPONENT_BITS) - 1;
const COEFFICIENT_BITS: u32 = 35;
const EXPONENT_BIAS: u64 = 16_384;

/// Every bit set. The vault writes this when a factor runs past the range it
/// can hold, which means the position has nothing left.
pub const MAX_DEBT_FACTOR: u64 = (1 << (COEFFICIENT_BITS + EXPONENT_BITS)) - 1;

/// A Jupiter Branch, reduced to the fields the walk needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Branch {
    pub status: u8,
    pub minima_tick: i32,
    pub minima_tick_partials: u32,
    pub debt_factor: u64,
    pub connected_branch_id: u32,
}

/// What the position is worth after the walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LivePosition {
    pub tick: i32,
    pub col_raw: u64,
    pub debt_raw: u64,
    /// Branch the walk finished on. 0 when the position was never liquidated.
    pub branch_id: u32,
}

/// Which branch liquidated a position, and the debt factor at that moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiquidationRecord {
    pub is_fully_liquidated: bool,
    pub branch_id: u32,
    pub connection_factor: u64,
}

/// Find the liquidation record for one position.
///
/// A tick keeps the record for the position ids it is holding right now in the
/// Tick account itself. Older ids are flushed to a TickIdLiquidation account,
/// which packs three ids per account. `(tick_id + 2) % 3` picks the slot.
pub fn liquidation_record(
    position_tick_id: u32,
    tick: &JupiterTick,
    tick_id_liquidation: Option<&JupiterTickIdLiquidation>,
) -> LiquidationRecord {
    if tick.total_ids == position_tick_id {
        return LiquidationRecord {
            is_fully_liquidated: tick.is_fully_liquidated == 1,
            branch_id: tick.liquidation_branch_id,
            connection_factor: tick.debt_factor,
        };
    }

    // A missing account means the vault never wrote a record, which reads as
    // "not liquidated": branch 0 and a zero factor.
    let Some(flushed) = tick_id_liquidation else {
        return LiquidationRecord {
            is_fully_liquidated: false,
            branch_id: 0,
            connection_factor: 0,
        };
    };

    let slot = &flushed.slots[((position_tick_id as usize) + 2) % 3];
    LiquidationRecord {
        is_fully_liquidated: slot.is_fully_liquidated == 1,
        branch_id: slot.liquidation_branch_id,
        connection_factor: slot.debt_factor,
    }
}

/// Multiply two packed debt factors.
///
/// Coefficients multiply and exponents add, same as any number in
/// `coefficient * 2^exponent` form. Two 35-bit coefficients make up to 70 bits,
/// so the product is shifted back down to 35 bits and the exponent is raised by
/// however much was shifted off.
pub fn mul_debt_factors(a: u64, b: u64) -> Result<u64> {
    let product = ((a >> EXPONENT_BITS) as u128) * ((b >> EXPONENT_BITS) as u128);

    // 70 bits needs 35 shifted off, 69 bits or fewer needs 34. Matching the
    // vault exactly here matters: an off-by-one changes every later factor.
    let shift = if product > (1u128 << 69) - 1 { COEFFICIENT_BITS } else { COEFFICIENT_BITS - 1 };

    let exponent = (a & EXPONENT_MAX) + (b & EXPONENT_MAX) + shift as u64;
    require!(exponent >= EXPONENT_BIAS, LendMirrorError::DebtFactorUnderflow);
    let exponent = exponent - EXPONENT_BIAS;
    if exponent > EXPONENT_MAX {
        return Ok(MAX_DEBT_FACTOR);
    }

    Ok((((product >> shift) as u64) << EXPONENT_BITS) | exponent)
}

/// `amount * numerator / denominator`, where both factors are packed.
///
/// Dividing two packed numbers subtracts their exponents, which is just a right
/// shift on the denominator's coefficient. Returns 0 when the result rounds
/// away to nothing.
pub fn mul_div_debt_factors(amount: u64, numerator: u64, denominator: u64) -> Result<u64> {
    if numerator == 0 || denominator == 0 {
        return Ok(0);
    }

    let exponent_gap = (denominator & EXPONENT_MAX)
        .checked_sub(numerator & EXPONENT_MAX)
        .ok_or(error!(LendMirrorError::DebtFactorUnderflow))?;

    let top = (amount as u128) * ((numerator >> EXPONENT_BITS) as u128);
    let bottom = (denominator >> EXPONENT_BITS) as u128;

    // `bottom << exponent_gap` would overflow u128, and anything that large is
    // far past `top` (99 bits at most), so the quotient is 0 either way.
    if exponent_gap > bottom.leading_zeros() as u64 {
        return Ok(0);
    }
    let bottom = bottom << exponent_gap;
    if bottom == 0 {
        return Ok(0);
    }

    u64::try_from(top / bottom).map_err(|_| error!(LendMirrorError::DebtFactorOverflow))
}

/// Follow the branch chain and work out what is left of the position.
///
/// `branch_by_id` hands back a decoded Branch. The caller is responsible for
/// proving the account it decodes really is that branch.
pub fn walk_branches<F>(
    start_branch_id: u32,
    start_connection_factor: u64,
    stored_debt_raw: u64,
    mut branch_by_id: F,
) -> Result<LivePosition>
where
    F: FnMut(u32) -> Result<Branch>,
{
    let mut branch_id = start_branch_id;
    let mut branch = branch_by_id(branch_id)?;
    let mut connection_factor = start_connection_factor;

    // A merged branch means this debt was rolled into another branch. Keep
    // following, compounding the factor at every hop.
    let mut hops = 0u32;
    while branch.status == BRANCH_MERGED {
        connection_factor = mul_debt_factors(connection_factor, branch.debt_factor)?;
        if connection_factor == MAX_DEBT_FACTOR {
            break;
        }
        branch_id = branch.connected_branch_id;
        branch = branch_by_id(branch_id)?;
        hops += 1;
        require!(hops <= MAX_BRANCH_HOPS, LendMirrorError::BranchChainTooLong);
    }

    let nothing_left = LivePosition { tick: MIN_TICK, col_raw: 0, debt_raw: 0, branch_id };

    // A closed branch was liquidated all the way down. A maxed-out factor means
    // the same thing by a different route.
    if branch.status == BRANCH_CLOSED || connection_factor == MAX_DEBT_FACTOR {
        return Ok(nothing_left);
    }

    let scaled = mul_div_debt_factors(stored_debt_raw, branch.debt_factor, connection_factor)?;

    // Anything under 1% of the original debt counts as wiped out. Above that,
    // the vault keeps 0.01% back as a rounding buffer.
    let debt_raw =
        if scaled > stored_debt_raw / 100 { ((scaled as u128 * 9_999) / 10_000) as u64 } else { 0 };
    if debt_raw == 0 {
        return Ok(nothing_left);
    }

    let col_raw =
        collateral_at_branch_minima(branch.minima_tick, branch.minima_tick_partials, debt_raw)?;

    Ok(LivePosition { tick: branch.minima_tick, col_raw, debt_raw, branch_id })
}

/// Collateral backing `debt_raw` at the branch's lowest point.
///
/// A branch stops part-way between two ticks. `minima_tick_partials` says how
/// far through, as a fraction of `X30`. So interpolate between the ratio one
/// tick below and the ratio at the tick, then divide the debt by it.
fn collateral_at_branch_minima(minima_tick: i32, partials: u32, debt_raw: u64) -> Result<u64> {
    let overflow = || error!(LendMirrorError::DebtFactorOverflow);

    let ratio = tick_math::get_ratio_at_tick(minima_tick)?;
    // Neighbouring ticks are 0.15% apart, so one tick down is `/ 1.0015`.
    let ratio_below = ratio.checked_mul(FOUR_DECIMALS).ok_or_else(overflow)? / TICK_SPACING;
    let span = ratio - ratio_below;
    let ratio = ratio_below + span.checked_mul(partials as u128).ok_or_else(overflow)? / X30;
    require!(ratio > 0, LendMirrorError::TickOutOfRange);

    let col = (debt_raw as u128).checked_mul(ZERO_TICK_SCALED_RATIO).ok_or_else(overflow)? / ratio;
    u64::try_from(col).map_err(|_| overflow())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{JupiterTick, JupiterTickIdLiquidation, TickIdLiquidationSlot};

    /// Pack a 35-bit coefficient and 15-bit exponent into a debt factor.
    /// `value = coefficient * 2^(exponent - 16384)`.
    fn pack(coefficient: u64, exponent: u64) -> u64 {
        assert!(coefficient < (1 << COEFFICIENT_BITS));
        assert!(exponent <= EXPONENT_MAX);
        (coefficient << EXPONENT_BITS) | exponent
    }

    fn open_branch(debt_factor: u64) -> Branch {
        Branch {
            status: 1,
            minima_tick: 0,
            minima_tick_partials: X30 as u32,
            debt_factor,
            connected_branch_id: 0,
        }
    }

    #[test]
    fn same_factors_leave_the_amount_then_keep_99_99_percent() {
        // Same packed factor on both sides of the divide cancels out.
        let factor = pack(1 << 34, EXPONENT_BIAS);
        assert_eq!(mul_div_debt_factors(1_000_000, factor, factor).unwrap(), 1_000_000);

        let live = walk_branches(1, factor, 1_000_000, |_| Ok(open_branch(factor))).unwrap();
        // Vault keeps 0.01% as a rounding buffer: 1_000_000 * 9999 / 10000.
        assert_eq!(live.debt_raw, 999_900);
        // Tick 0, full partials → collateral equals debt.
        assert_eq!(live.col_raw, 999_900);
        assert_eq!(live.tick, 0);
        assert_eq!(live.branch_id, 1);
    }

    #[test]
    fn debt_under_one_percent_is_wiped() {
        let tiny_numerator = pack(1 << 34, EXPONENT_BIAS);
        let huge_denominator = pack(1 << 34, EXPONENT_BIAS + 8);
        let scaled = mul_div_debt_factors(10_000, tiny_numerator, huge_denominator).unwrap();
        assert!(scaled <= 10_000 / 100);

        let live = walk_branches(1, huge_denominator, 10_000, |_| Ok(open_branch(tiny_numerator)))
            .unwrap();
        assert_eq!(live.debt_raw, 0);
        assert_eq!(live.col_raw, 0);
        assert_eq!(live.tick, MIN_TICK);
    }

    #[test]
    fn closed_branch_is_empty() {
        let factor = pack(1 << 34, EXPONENT_BIAS);
        let live = walk_branches(4, factor, 50_000, |_| {
            Ok(Branch {
                status: BRANCH_CLOSED,
                minima_tick: -100,
                minima_tick_partials: 0,
                debt_factor: factor,
                connected_branch_id: 0,
            })
        })
        .unwrap();
        assert_eq!(live, LivePosition { tick: MIN_TICK, col_raw: 0, debt_raw: 0, branch_id: 4 });
    }

    #[test]
    fn merged_branch_follows_the_connected_id() {
        // A merged hop whose packed factor is 1.0 leaves the connection
        // unchanged, then the open branch behaves like the single-hop case.
        let one = pack(1 << 34, 16_350);
        let factor = pack(1 << 34, EXPONENT_BIAS);
        let live = walk_branches(1, factor, 1_000_000, |id| match id {
            1 => Ok(Branch {
                status: BRANCH_MERGED,
                minima_tick: -200,
                minima_tick_partials: 0,
                debt_factor: one,
                connected_branch_id: 2,
            }),
            2 => Ok(open_branch(factor)),
            _ => panic!("unexpected branch {id}"),
        })
        .unwrap();
        assert_eq!(live.branch_id, 2);
        assert_eq!(live.debt_raw, 999_900);
        assert_eq!(live.tick, 0);
    }

    #[test]
    fn maxed_out_factor_is_empty() {
        let live = walk_branches(7, MAX_DEBT_FACTOR, 80_000, |_| Ok(open_branch(1))).unwrap();
        assert_eq!(live.col_raw, 0);
        assert_eq!(live.debt_raw, 0);
        assert_eq!(live.tick, MIN_TICK);
        assert_eq!(live.branch_id, 7);
    }

    #[test]
    fn current_tick_ids_use_the_tick_account() {
        let tick = JupiterTick {
            vault_id: 1,
            tick: -100,
            is_liquidated: 1,
            total_ids: 5,
            raw_debt: 0,
            is_fully_liquidated: 0,
            liquidation_branch_id: 9,
            debt_factor: 123,
        };
        let record = liquidation_record(5, &tick, None);
        assert!(!record.is_fully_liquidated);
        assert_eq!(record.branch_id, 9);
        assert_eq!(record.connection_factor, 123);
    }

    #[test]
    fn flushed_ids_use_slot_tick_id_plus_two_mod_three() {
        let tick = JupiterTick {
            vault_id: 1,
            tick: -100,
            is_liquidated: 1,
            total_ids: 9,
            raw_debt: 0,
            is_fully_liquidated: 0,
            liquidation_branch_id: 0,
            debt_factor: 0,
        };
        let flushed = JupiterTickIdLiquidation {
            vault_id: 1,
            tick: -100,
            tick_map: 0,
            slots: [
                TickIdLiquidationSlot {
                    is_fully_liquidated: 1,
                    liquidation_branch_id: 10,
                    debt_factor: 100,
                },
                TickIdLiquidationSlot {
                    is_fully_liquidated: 0,
                    liquidation_branch_id: 20,
                    debt_factor: 200,
                },
                TickIdLiquidationSlot {
                    is_fully_liquidated: 0,
                    liquidation_branch_id: 30,
                    debt_factor: 300,
                },
            ],
        };
        // (1 + 2) % 3 = 0
        let a = liquidation_record(1, &tick, Some(&flushed));
        assert!(a.is_fully_liquidated);
        assert_eq!(a.branch_id, 10);
        // (2 + 2) % 3 = 1
        let b = liquidation_record(2, &tick, Some(&flushed));
        assert_eq!(b.branch_id, 20);
        assert_eq!(b.connection_factor, 200);
        // (3 + 2) % 3 = 2
        let c = liquidation_record(3, &tick, Some(&flushed));
        assert_eq!(c.branch_id, 30);
    }

    #[test]
    fn missing_flushed_account_reads_as_not_liquidated() {
        let tick = JupiterTick {
            vault_id: 1,
            tick: -100,
            is_liquidated: 1,
            total_ids: 9,
            raw_debt: 0,
            is_fully_liquidated: 0,
            liquidation_branch_id: 0,
            debt_factor: 0,
        };
        let record = liquidation_record(1, &tick, None);
        assert!(!record.is_fully_liquidated);
        assert_eq!(record.branch_id, 0);
        assert_eq!(record.connection_factor, 0);
    }

    #[test]
    fn multiplying_two_factors_shifts_70_bit_products_back_to_35_bits() {
        let a = pack(1 << 34, EXPONENT_BIAS);
        let product = mul_debt_factors(a, a).unwrap();
        // (2^34 * 2^34) = 2^68, which is under 2^69, so shift 34.
        // exponent = 16384 + 16384 + 34 - 16384 = 16418.
        assert_eq!(product, pack(1 << 34, 16_418));
    }
}
