//! Our `tick_math` vs `jup_lend_sdk::math::tick::TickMath`.
//!
//! No RPC. Run from this folder: `cargo test`

use jup_lend_sdk::borrow::pda::get_tick;
use jup_lend_sdk::borrow::VAULTS_PROGRAM_ID;
use jup_lend_sdk::math::tick::TickMath;
use lendmirror::tick_math::{
    debt_raw_at_tick, get_ratio_at_tick, liquidation_debt_raw_at_tick, normalize_tick,
    tick_pda_seed, MAX_TICK, MIN_TICK,
};
use anchor_lang::prelude::Pubkey;
use lendmirror::JUPITER_VAULTS_MAINNET;

fn sdk_shown_debt(tick: i32, col: u64) -> u64 {
    let t = normalize_tick(tick);
    if t <= MIN_TICK {
        return 0;
    }
    let ratio = TickMath::get_ratio_at_tick(t).expect("sdk ratio");
    // getPositionByVaultIdV2, before a liquidation: ratio * col >> 48.
    u64::try_from(ratio * col as u128 >> 48).expect("debt should fit u64")
}

fn sdk_liquidation_start_debt(tick: i32, col: u64) -> u64 {
    let t = normalize_tick(tick);
    if t <= MIN_TICK {
        return 0;
    }
    let ratio = TickMath::get_ratio_at_tick(t).expect("sdk ratio");
    // getCurrentPositionState, the debt a liquidation walk starts from.
    let debt = (ratio * (col as u128 + 1) >> 48) + 1;
    u64::try_from(debt).expect("debt should fit u64")
}

#[test]
fn ratio_at_tick_matches_sdk() {
    let ticks = [
        MIN_TICK,
        -1000,
        -100,
        -1,
        0,
        1,
        100,
        1000,
        MAX_TICK,
    ];
    for tick in ticks {
        let ours = get_ratio_at_tick(tick).expect("ours");
        let sdk = TickMath::get_ratio_at_tick(tick).expect("sdk");
        assert_eq!(ours, sdk, "ratio mismatch at tick {tick}");
    }
}

#[test]
fn debt_for_a_position_matches_sdk() {
    let col = 10_000_000u64;
    let ticks = [-1000, -100, -1, 0, 1, 100];
    for tick in ticks {
        let ours = debt_raw_at_tick(tick, col).expect("ours debt");
        let sdk = sdk_shown_debt(tick, col);
        assert_eq!(ours, sdk, "shown debt mismatch at tick {tick} col {col}");

        let ours_start = liquidation_debt_raw_at_tick(tick, col).expect("ours start debt");
        let sdk_start = sdk_liquidation_start_debt(tick, col);
        assert_eq!(ours_start, sdk_start, "liquidation start mismatch at tick {tick} col {col}");
    }
}

#[test]
fn min_tick_has_no_debt_on_either_side() {
    assert_eq!(debt_raw_at_tick(MIN_TICK, 10_000_000).unwrap(), 0);
    assert_eq!(liquidation_debt_raw_at_tick(MIN_TICK, 10_000_000).unwrap(), 0);
    assert_eq!(sdk_shown_debt(MIN_TICK, 10_000_000), 0);
    assert_eq!(sdk_liquidation_start_debt(MIN_TICK, 10_000_000), 0);
}

#[test]
fn vaults_program_id_matches() {
    assert_eq!(
        JUPITER_VAULTS_MAINNET.to_bytes(),
        VAULTS_PROGRAM_ID.to_bytes()
    );
}

#[test]
fn tick_pda_matches_sdk() {
    let vault_id = 1u16;
    for tick in [-16383i32, -100, 0, 100, 16383] {
        let ours = Pubkey::find_program_address(
            &[b"tick", &vault_id.to_le_bytes(), &tick_pda_seed(tick)],
            &JUPITER_VAULTS_MAINNET,
        )
        .0;
        let sdk = get_tick(vault_id, tick);
        assert_eq!(ours.to_bytes(), sdk.to_bytes(), "tick PDA mismatch at {tick}");
    }
}
