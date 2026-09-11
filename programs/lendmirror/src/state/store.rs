use crate::*;

/// The Store PDA is our OApp identity on Solana.
/// LayerZero PacketSent.sender = this account's pubkey, not the program id.
/// Ethereum setPeer(40168, store) must use this address.
///
/// #[account] is NOT the PDA seed. It only packs this struct into account bytes:
///   [8-byte discriminator][admin][bump][endpoint_program][string]
/// The seed lives in init_store / send as `seeds = [STORE_SEED]`.
/// The 8 bytes stop you passing a PeerConfig account where a Store is required.
#[account]
pub struct Store {
    pub admin: Pubkey,
    pub bump: u8, // PDA bump so we can sign CPIs as the Store
    pub endpoint_program: Pubkey,
    pub string: String, // starter leftover: last string received ON Solana
}

impl Store {
    pub const MAX_STRING_LENGTH: usize = 256;
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>() + Self::MAX_STRING_LENGTH;
}

// The LzReceiveTypesAccounts PDA is used by the Executor as a prerequisite to calling `lz_receive`.
#[account]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey, // Note: This is used as your OApp address.
    pub alt: Pubkey, // Note: in this example, we store a single ALT. You can modify this to store a Vec of Pubkeys too.
    pub bump: u8, // the bump of the lz_receive_types_accounts PDA
}

impl LzReceiveTypesAccounts {
    pub const SIZE: usize = 8 + std::mem::size_of::<Self>();
}


