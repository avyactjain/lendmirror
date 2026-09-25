use crate::state::jupiter_position::PositionSnapshot;
use crate::state::store::ALLOWLIST_LEN;
use anchor_lang::prelude::*;

/// One PDA per Jupiter position. Seeds: `["LendMirrorWrapper", vault_id le, nft_id le]`.
///
/// `owner` is the wallet that called `wrap_position` (not the program id).
/// `lz_send_allowed` / `ccip_send_allowed` start false; `request_bridge_ondemand` sets them true.
#[account]
#[derive(InitSpace)]
pub struct PositionWrapper {
    pub owner: Pubkey,
    pub vault_id: u16,
    pub nft_id: u32,
    pub bump: u8,
    /// Live snapshot. Empty until `refresh_wrapper`.
    pub snapshot: Option<PositionSnapshot>,
    /// When true, `send` may encode `snapshot` and clear this flag.
    pub lz_send_allowed: bool,
    /// When true, `send_ccip` may encode `snapshot` and clear this flag.
    pub ccip_send_allowed: bool,
}

impl PositionWrapper {
    pub fn is_owner(&self, key: &Pubkey) -> bool {
        self.owner == *key
    }
}

/// Allowlist for who may call `request_bridge_ondemand` on one wrapper.
/// Seeds: `["LendMirrorOnDemand", wrapper.key()]`.
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
