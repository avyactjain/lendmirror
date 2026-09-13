use crate::*;

/// The Store PDA is our OApp identity on Solana.
/// LayerZero PacketSent.sender = this account's pubkey, not the program id.
/// Ethereum setPeer(40168, store) must use this address.
///
/// #[account] is NOT the PDA seed. It only packs this struct into account bytes:
///   [8-byte discriminator][admin][bump][endpoint_program][price_store]
/// The seed lives in init_store / send as `seeds = [STORE_SEED]`.
/// The 8 bytes stop you passing a PeerConfig account where a Store is required.
#[account]
#[derive(InitSpace)]
pub struct Store {
    pub admin: Pubkey,
    pub bump: u8, // PDA bump so we can sign CPIs as the Store
    pub endpoint_program: Pubkey,
    pub price_store: Option<PythPrice>, // PythPrice account
}
