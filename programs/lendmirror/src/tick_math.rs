//! Jupiter Vaults / Fluid tick ratio. Same constants as `@jup-ag/lend-read` `TickMath`.

use crate::errors::LendMirrorError;
use anchor_lang::prelude::*;

pub const MIN_TICK: i32 = -16383;
pub const MAX_TICK: i32 = 16383;
pub const INIT_TICK: i32 = i32::MIN;
/// Added to `tick` when deriving the Tick PDA (u32 LE).
pub const TICK_PDA_OFFSET: i32 = MAX_TICK;

const FACTOR00: u128 = 18446744073709551616;
const FACTOR01: u128 = 18419115400608638658;
const FACTOR02: u128 = 18391528108445969703;
const FACTOR03: u128 = 18336477419114433396;
const FACTOR04: u128 = 18226869890870665593;
const FACTOR05: u128 = 18009616477100071088;
const FACTOR06: u128 = 17582847377087825313;
const FACTOR07: u128 = 16759408633341240198;
const FACTOR08: u128 = 15226414841393184936;
const FACTOR09: u128 = 12568272644527235157;
const FACTOR10: u128 = 8563108841104354677;
const FACTOR11: u128 = 3975055583337633975;
const FACTOR12: u128 = 856577552520149366;
const FACTOR13: u128 = 39775317560084773;
const FACTOR14: u128 = 85764505686420;
const FACTOR15: u128 = 398745188;

pub fn normalize_tick(tick: i32) -> i32 {
    if tick == INIT_TICK {
        MIN_TICK
    } else {
        tick
    }
}

pub fn tick_pda_seed(tick: i32) -> [u8; 4] {
    let t = normalize_tick(tick);
    ((t + TICK_PDA_OFFSET) as u32).to_le_bytes()
}

/// X48 ratio at `tick`. Tick 0 is 2^48.
pub fn get_ratio_at_tick(tick: i32) -> Result<u128> {
    require!(tick >= MIN_TICK && tick <= MAX_TICK, LendMirrorError::TickOutOfRange);

    let abs_tick = tick.unsigned_abs();
    let mut factor = if abs_tick & 1 != 0 { FACTOR01 } else { FACTOR00 };
    if abs_tick & 2 != 0 {
        factor = mul_shift_64(factor, FACTOR02);
    }
    if abs_tick & 4 != 0 {
        factor = mul_shift_64(factor, FACTOR03);
    }
    if abs_tick & 8 != 0 {
        factor = mul_shift_64(factor, FACTOR04);
    }
    if abs_tick & 16 != 0 {
        factor = mul_shift_64(factor, FACTOR05);
    }
    if abs_tick & 32 != 0 {
        factor = mul_shift_64(factor, FACTOR06);
    }
    if abs_tick & 64 != 0 {
        factor = mul_shift_64(factor, FACTOR07);
    }
    if abs_tick & 128 != 0 {
        factor = mul_shift_64(factor, FACTOR08);
    }
    if abs_tick & 256 != 0 {
        factor = mul_shift_64(factor, FACTOR09);
    }
    if abs_tick & 512 != 0 {
        factor = mul_shift_64(factor, FACTOR10);
    }
    if abs_tick & 1024 != 0 {
        factor = mul_shift_64(factor, FACTOR11);
    }
    if abs_tick & 2048 != 0 {
        factor = mul_shift_64(factor, FACTOR12);
    }
    if abs_tick & 4096 != 0 {
        factor = mul_shift_64(factor, FACTOR13);
    }
    if abs_tick & 8192 != 0 {
        factor = mul_shift_64(factor, FACTOR14);
    }
    if abs_tick & 16384 != 0 {
        factor = mul_shift_64(factor, FACTOR15);
    }

    let mut precision: u128 = 0;
    if tick > 0 {
        factor = u128::MAX / factor;
        if factor % 65536 != 0 {
            precision = 1;
        }
    }

    Ok((factor >> 16) + precision)
}

/// Healthy-position debt: `ratio * (col + 1) >> 48 + 1`.
pub fn debt_raw_at_tick(tick: i32, col_raw: u64) -> Result<u64> {
    let t = normalize_tick(tick);
    if t <= MIN_TICK {
        return Ok(0);
    }
    let ratio = get_ratio_at_tick(t)?;
    let product_shr = mul_shr(ratio, (col_raw as u128) + 1, 48);
    let debt = product_shr.saturating_add(1);
    u64::try_from(debt).map_err(|_| error!(LendMirrorError::TickOutOfRange))
}

fn mul_shift_64(n0: u128, n1: u128) -> u128 {
    mul_shr(n0, n1, 64)
}

fn mul_u128(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a & 0xffff_ffff_ffff_ffff;
    let a_hi = a >> 64;
    let b_lo = b & 0xffff_ffff_ffff_ffff;
    let b_hi = b >> 64;

    let p0 = a_lo * b_lo;
    let p1 = a_lo * b_hi;
    let p2 = a_hi * b_lo;
    let p3 = a_hi * b_hi;

    let p0_lo = p0 & 0xffff_ffff_ffff_ffff;
    let p0_hi = p0 >> 64;
    let mid = p0_hi + (p1 & 0xffff_ffff_ffff_ffff) + (p2 & 0xffff_ffff_ffff_ffff);
    let lo = p0_lo | (mid << 64);
    let hi = p3 + (p1 >> 64) + (p2 >> 64) + (mid >> 64);
    (hi, lo)
}

fn mul_shr(a: u128, b: u128, shift: u32) -> u128 {
    let (hi, lo) = mul_u128(a, b);
    if shift == 0 {
        lo
    } else if shift < 128 {
        (lo >> shift) | (hi << (128 - shift))
    } else if shift < 256 {
        hi >> (shift - 128)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_zero_ratio_is_2_pow_48() {
        assert_eq!(get_ratio_at_tick(0).unwrap(), 1u128 << 48);
    }

    #[test]
    fn debt_at_tick_zero() {
        // (2^48 * 101) >> 48 + 1 = 102
        assert_eq!(debt_raw_at_tick(0, 100).unwrap(), 102);
    }

    #[test]
    fn min_tick_has_no_debt() {
        assert_eq!(debt_raw_at_tick(MIN_TICK, 1_000).unwrap(), 0);
        assert_eq!(debt_raw_at_tick(INIT_TICK, 1_000).unwrap(), 0);
    }

    #[test]
    fn tick_pda_seed_min_is_zero() {
        assert_eq!(tick_pda_seed(MIN_TICK), 0u32.to_le_bytes());
        assert_eq!(tick_pda_seed(INIT_TICK), 0u32.to_le_bytes());
    }
}
