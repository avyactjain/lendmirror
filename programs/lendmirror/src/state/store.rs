use crate::errors::LendMirrorError;
use crate::*;

/// Max wallets on each allowlist (snapshotters / senders).
pub const ALLOWLIST_LEN: usize = 8;

/// The Store PDA is our OApp identity on Solana.
/// LayerZero PacketSent.sender = this account's pubkey, not the program id.
/// Ethereum setPeer must use this address.
///
/// Created once by `init_store`. Only this program's upgrade authority can
/// call that instruction. `admin` is then the operational key for allowlists.
///
/// #[account] is NOT the PDA seed. It only packs this struct into account bytes.
/// The seed lives in init_store / send as `seeds = [STORE_SEED]`.
/// The 8 bytes stop you passing a PeerConfig account where a Store is required.
#[account]
#[derive(InitSpace)]
pub struct Store {
    pub admin: Pubkey,
    pub bump: u8, // PDA bump so we can sign CPIs as the Store
    pub endpoint_program: Pubkey,
    /// Jupiter Lend Vaults program. Set once in init_store (Devnet vs mainnet).
    pub vaults_program: Pubkey,
    /// Wallets allowed to call `get_jupiter_position`. Admin updates only.
    pub snapshotters: [Pubkey; ALLOWLIST_LEN],
    pub snapshotter_count: u8,
    /// Wallets allowed to call `send`. Admin updates only.
    pub senders: [Pubkey; ALLOWLIST_LEN],
    pub sender_count: u8,
    pub last_position: Option<PositionSnapshot>,
}

impl Store {
    pub fn is_snapshotter(&self, key: &Pubkey) -> bool {
        self.snapshotters[..self.snapshotter_count as usize].iter().any(|k| k == key)
    }

    pub fn is_sender(&self, key: &Pubkey) -> bool {
        self.senders[..self.sender_count as usize].iter().any(|k| k == key)
    }

    pub fn set_snapshotters(&mut self, keys: &[Pubkey]) -> Result<()> {
        require!(keys.len() <= ALLOWLIST_LEN, LendMirrorError::AllowlistTooLong);
        self.snapshotters = [Pubkey::default(); ALLOWLIST_LEN];
        for (i, key) in keys.iter().enumerate() {
            self.snapshotters[i] = *key;
        }
        self.snapshotter_count = keys.len() as u8;
        Ok(())
    }

    pub fn set_senders(&mut self, keys: &[Pubkey]) -> Result<()> {
        require!(keys.len() <= ALLOWLIST_LEN, LendMirrorError::AllowlistTooLong);
        self.senders = [Pubkey::default(); ALLOWLIST_LEN];
        for (i, key) in keys.iter().enumerate() {
            self.senders[i] = *key;
        }
        self.sender_count = keys.len() as u8;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_store() -> Store {
        Store {
            admin: Pubkey::new_unique(),
            bump: 255,
            endpoint_program: Pubkey::default(),
            vaults_program: Pubkey::default(),
            snapshotters: [Pubkey::default(); ALLOWLIST_LEN],
            snapshotter_count: 0,
            senders: [Pubkey::default(); ALLOWLIST_LEN],
            sender_count: 0,
            last_position: None,
        }
    }

    #[test]
    fn empty_lists_reject_everyone() {
        let store = empty_store();
        let stranger = Pubkey::new_unique();
        assert!(!store.is_snapshotter(&stranger));
        assert!(!store.is_sender(&stranger));
    }

    #[test]
    fn snapshotters_membership_and_replace() {
        let mut store = empty_store();
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();

        store.set_snapshotters(&[a]).unwrap();
        assert!(store.is_snapshotter(&a));
        assert!(!store.is_snapshotter(&b));
        assert!(!store.is_snapshotter(&stranger));
        assert_eq!(store.snapshotter_count, 1);

        store.set_snapshotters(&[b, a]).unwrap();
        assert!(store.is_snapshotter(&a));
        assert!(store.is_snapshotter(&b));
        assert_eq!(store.snapshotter_count, 2);
        // Prior sole entry still present; list was replaced not appended.
        assert!(!store.is_snapshotter(&stranger));
    }

    #[test]
    fn senders_membership_and_replace() {
        let mut store = empty_store();
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();

        store.set_senders(&[a]).unwrap();
        assert!(store.is_sender(&a));
        assert!(!store.is_sender(&b));
        assert_eq!(store.sender_count, 1);

        store.set_senders(&[b]).unwrap();
        assert!(!store.is_sender(&a));
        assert!(store.is_sender(&b));
        assert_eq!(store.sender_count, 1);
    }

    #[test]
    fn allowlist_max_eight_then_too_long() {
        let mut store = empty_store();
        let eight: Vec<Pubkey> = (0..ALLOWLIST_LEN).map(|_| Pubkey::new_unique()).collect();
        store.set_snapshotters(&eight).unwrap();
        assert_eq!(store.snapshotter_count, 8);
        assert!(store.is_snapshotter(&eight[7]));

        let nine: Vec<Pubkey> = (0..ALLOWLIST_LEN + 1).map(|_| Pubkey::new_unique()).collect();
        let err = store.set_snapshotters(&nine).unwrap_err();
        assert_eq!(err, error!(LendMirrorError::AllowlistTooLong));

        let err = store.set_senders(&nine).unwrap_err();
        assert_eq!(err, error!(LendMirrorError::AllowlistTooLong));
    }

    #[test]
    fn init_style_seed_puts_admin_on_both_lists() {
        let mut store = empty_store();
        let admin = store.admin;
        store.set_snapshotters(&[admin]).unwrap();
        store.set_senders(&[admin]).unwrap();
        assert!(store.is_snapshotter(&admin));
        assert!(store.is_sender(&admin));
    }
}
