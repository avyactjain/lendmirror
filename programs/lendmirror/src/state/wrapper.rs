//! Per-position bookkeeping: one `PositionWrapper` for each Jupiter position we track, plus
//! its optional `OnDemandStrategy` caller list.
//!
//! Owns: the wrapper layout, the level policy (`level_allows`), and the send guard
//! (`can_send` / `record_send`). Does NOT own: reading Jupiter (see
//! `instructions/get_jupiter_position.rs`) or sending (see
//! `instructions/send_position_snapshot.rs`).
//!
//! Invariants:
//!   - A wrapper's address is fixed by `[WRAPPER_SEED, vault_id le, nft_id le]`. Two wrappers
//!     can never point at the same Jupiter position.
//!   - `last_sent_snapshot_time` only moves forward. A snapshot is sent at most once.
//!   - `level` is written only by the Store admin (`set_wrapper_level`).
//!   - Every token account the wrapper controls (position NFT, collateral, debt token) is an
//!     associated token account owned by the wrapper AUTHORITY, an empty PDA at
//!     `[WRAPPER_AUTH_SEED, wrapper.key()]`. The wrapper account itself holds data, and the
//!     System program refuses to move lamports out of a data-carrying account, so it cannot
//!     act as a fee payer or as Jupiter's `signer`. The empty authority PDA can.
//!
//! Typical call: `wrap_position` creates the account → `refresh_wrapper` fills `snapshot`
//! → `send_position_snapshot_via_chainlink_and_lz` checks `can_send`, sends, calls `record_send`.
//!
//! Anchor notes for readers new to Solana:
//!   - `#[account]` adds an 8-byte type tag (the "discriminator") in front of the struct bytes and
//!     derives the Borsh (de)serializers. The tag stops a caller handing us the wrong account type.
//!   - `#[derive(InitSpace)]` computes `INIT_SPACE`, the byte size of the struct, so `init` can
//!     allocate `8 + INIT_SPACE` bytes. Every field must have a fixed size for this to work.
//!   - Solana accounts cannot grow for free, so changing this layout means a new seed. That is
//!     why the seed is `LendMirrorPositionWrapperV1`: wrappers under the older seeds
//!     (`LendMirrorWrapper`, `LendMirrorPositionWrapperV1`) still exist on
//!     Devnet with the old layout and are simply left behind.

use crate::state::jupiter_position::PositionSnapshot;
use crate::state::store::ALLOWLIST_LEN;
use anchor_lang::prelude::*;

/// Layout version stored in every wrapper. Bump when the byte layout changes again.
pub const WRAPPER_VERSION: u8 = 1;

/// Access level 1: deposit collateral and pay back debt. Both lower the position's risk.
pub const LEVEL_DEPOSIT_PAYBACK: u8 = 1;
/// Access level 2: level 1 plus withdraw collateral and borrow. Both raise the risk.
pub const LEVEL_WITHDRAW_BORROW: u8 = 2;
/// Highest level the admin may store. Levels 3 and 4 are reserved and reject every operation.
pub const LEVEL_MAX: u8 = 4;

/// One PDA per Jupiter position. Seeds: `["LendMirrorPositionWrapperV1", vault_id le, nft_id le]`.
///
/// `owner` is the wallet that called `wrap_position`, replaced by whoever deposits the position
/// NFT (`deposit_position_nft`). Never the program id.
#[account]
#[derive(InitSpace)]
pub struct PositionWrapper {
    pub owner: Pubkey,
    pub vault_id: u16,
    pub nft_id: u32,
    /// PDA bump. Needed to sign as this wrapper in CPIs (`invoke_signed`).
    pub bump: u8,
    /// Live snapshot. Empty until `refresh_wrapper`.
    pub snapshot: Option<PositionSnapshot>,
    /// Always `WRAPPER_VERSION`. Lets a client tell layouts apart.
    pub version: u8,
    /// Access level 0..=4. 0 means "mirror only, no operations". See `level_allows`.
    pub level: u8,
    /// True once the position NFT sits in this wrapper's token account.
    pub custody: bool,
    /// Mint of the position NFT. Zero until `deposit_position_nft`.
    pub position_mint: Pubkey,
    /// `snapshot_time` of the last snapshot that went out. 0 before the first send.
    pub last_sent_snapshot_time: i64,
    /// How many sends this wrapper has made. Informational.
    pub send_count: u64,
    /// Bump of the wrapper authority PDA (`[WRAPPER_AUTH_SEED, wrapper.key()]`). Stored so
    /// `invoke_signed` does not have to search for it on every call.
    pub authority_bump: u8,
    /// Spare bytes so small future fields do not force another seed bump.
    pub reserved: [u8; 64],
}

impl PositionWrapper {
    pub fn is_owner(&self, key: &Pubkey) -> bool {
        self.owner == *key
    }

    /// True when `snapshot_time` is newer than the last snapshot that was sent.
    ///
    /// `refresh_wrapper` stamps each snapshot with the current clock, so "newer" means
    /// "refreshed since the last send". A fresh wrapper (`last_sent_snapshot_time == 0`)
    /// accepts any positive time.
    pub fn can_send(&self, snapshot_time: i64) -> bool {
        snapshot_time > self.last_sent_snapshot_time
    }

    /// Remember that the snapshot stamped `snapshot_time` went out.
    pub fn record_send(&mut self, snapshot_time: i64) {
        self.last_sent_snapshot_time = snapshot_time;
        self.send_count = self.send_count.saturating_add(1);
    }
}

/// Does `level` allow a Jupiter `operate` call with these signed amounts?
///
/// Amounts follow Jupiter's convention: positive `new_col` deposits, negative withdraws;
/// positive `new_debt` borrows, negative pays back. `i128::MIN` means "all".
///
/// `level_allows(1, 100, 0)` → true (deposit). `level_allows(1, 0, 50)` → false (borrow).
/// `level_allows(2, -100, 50)` → true. `level_allows(3, 100, 0)` → false (reserved).
pub fn level_allows(level: u8, new_col: i128, new_debt: i128) -> bool {
    match level {
        LEVEL_DEPOSIT_PAYBACK => new_col >= 0 && new_debt <= 0,
        LEVEL_WITHDRAW_BORROW => true,
        // Level 0 has no rights. Levels 3 and 4 are stored but not defined yet.
        _ => false,
    }
}

/// Allowlist for who may refresh and send one wrapper's snapshot.
/// Seeds: `["LendMirrorOnDemandV1", wrapper.key()]`.
#[account]
#[derive(InitSpace)]
pub struct OnDemandStrategy {
    /// Parent wrapper PDA.
    pub wrapper: Pubkey,
    pub bump: u8,
    pub callers: [Pubkey; ALLOWLIST_LEN],
    pub caller_count: u8,
}

impl OnDemandStrategy {
    pub fn is_caller(&self, key: &Pubkey) -> bool {
        self.callers[..self.caller_count as usize].iter().any(|k| k == key)
    }

    pub fn set_callers(&mut self, keys: &[Pubkey]) -> Result<()> {
        require!(keys.len() <= ALLOWLIST_LEN, crate::errors::LendMirrorError::AllowlistTooLong);
        self.callers = [Pubkey::default(); ALLOWLIST_LEN];
        for (i, key) in keys.iter().enumerate() {
            self.callers[i] = *key;
        }
        self.caller_count = keys.len() as u8;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_wrapper() -> PositionWrapper {
        PositionWrapper {
            owner: Pubkey::new_unique(),
            vault_id: 1,
            nft_id: 29,
            bump: 255,
            snapshot: None,
            version: WRAPPER_VERSION,
            level: 0,
            custody: false,
            position_mint: Pubkey::default(),
            last_sent_snapshot_time: 0,
            send_count: 0,
            authority_bump: 254,
            reserved: [0; 64],
        }
    }

    #[test]
    fn send_guard_allows_each_snapshot_once() {
        let mut w = fresh_wrapper();
        assert!(w.can_send(1_700_000_000));
        w.record_send(1_700_000_000);
        assert!(!w.can_send(1_700_000_000), "same snapshot cannot go out twice");
        assert!(!w.can_send(1_699_999_999), "older snapshot cannot go out");
        assert!(w.can_send(1_700_000_001), "a refresh makes a newer snapshot sendable");
        assert_eq!(w.send_count, 1);
    }

    #[test]
    fn level_one_only_lowers_risk() {
        assert!(level_allows(1, 100, 0)); // deposit
        assert!(level_allows(1, 0, -50)); // payback
        assert!(level_allows(1, 100, -50)); // both
        assert!(level_allows(1, 0, i128::MIN)); // payback all
        assert!(!level_allows(1, -1, 0)); // withdraw
        assert!(!level_allows(1, 0, 1)); // borrow
        assert!(!level_allows(1, i128::MIN, 0)); // withdraw all
    }

    #[test]
    fn level_two_allows_everything_and_others_nothing() {
        assert!(level_allows(2, -100, 50));
        assert!(level_allows(2, i128::MIN, i128::MIN));
        for level in [0u8, 3, 4, 5, 255] {
            assert!(!level_allows(level, 100, 0), "level {level} must reject even a deposit");
        }
    }

    #[test]
    fn ondemand_callers_membership_and_replace() {
        let mut s = OnDemandStrategy {
            wrapper: Pubkey::new_unique(),
            bump: 255,
            callers: [Pubkey::default(); ALLOWLIST_LEN],
            caller_count: 0,
        };
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        s.set_callers(&[a]).unwrap();
        assert!(s.is_caller(&a));
        assert!(!s.is_caller(&b));
        s.set_callers(&[b, a]).unwrap();
        assert!(s.is_caller(&a));
        assert!(s.is_caller(&b));
        assert_eq!(s.caller_count, 2);
    }

    #[test]
    fn ondemand_rejects_nine_callers() {
        let mut s = OnDemandStrategy {
            wrapper: Pubkey::new_unique(),
            bump: 255,
            callers: [Pubkey::default(); ALLOWLIST_LEN],
            caller_count: 0,
        };
        let nine: Vec<Pubkey> = (0..ALLOWLIST_LEN + 1).map(|_| Pubkey::new_unique()).collect();
        assert_eq!(
            s.set_callers(&nine).unwrap_err(),
            error!(crate::errors::LendMirrorError::AllowlistTooLong)
        );
    }
}
