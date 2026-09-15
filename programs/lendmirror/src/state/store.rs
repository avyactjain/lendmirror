use crate::errors::LendMirrorError;
use crate::*;

/// Max wallets on each allowlist (snapshotters / senders).
pub const ALLOWLIST_LEN: usize = 8;

/// The Store PDA is our OApp identity on Solana.
/// LayerZero PacketSent.sender = this account's pubkey, not the program id.
/// Ethereum setPeer must use this address.
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
        self.snapshotters[..self.snapshotter_count as usize]
            .iter()
            .any(|k| k == key)
    }

    pub fn is_sender(&self, key: &Pubkey) -> bool {
        self.senders[..self.sender_count as usize]
            .iter()
            .any(|k| k == key)
    }

    pub fn set_snapshotters(&mut self, keys: &[Pubkey]) -> Result<()> {
        require!(
            keys.len() <= ALLOWLIST_LEN,
            LendMirrorError::AllowlistTooLong
        );
        self.snapshotters = [Pubkey::default(); ALLOWLIST_LEN];
        for (i, key) in keys.iter().enumerate() {
            self.snapshotters[i] = *key;
        }
        self.snapshotter_count = keys.len() as u8;
        Ok(())
    }

    pub fn set_senders(&mut self, keys: &[Pubkey]) -> Result<()> {
        require!(
            keys.len() <= ALLOWLIST_LEN,
            LendMirrorError::AllowlistTooLong
        );
        self.senders = [Pubkey::default(); ALLOWLIST_LEN];
        for (i, key) in keys.iter().enumerate() {
            self.senders[i] = *key;
        }
        self.sender_count = keys.len() as u8;
        Ok(())
    }
}
