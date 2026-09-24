use anchor_lang::prelude::*;

/// Where `send_ccip` delivers the snapshot body.
/// Separate from the Store so the Store layout stays as it is.
///
/// Seed: `["LendMirrorCcip"]`.
#[account]
#[derive(InitSpace)]
pub struct CcipRoute {
    pub router: Pubkey,
    pub fee_quoter: Pubkey,
    pub rmn_remote: Pubkey,
    pub link_mint: Pubkey,
    /// CCIP chain selector of the destination (Sepolia is 16015286601757825753).
    pub dest_chain_selector: u64,
    /// Ethereum LendMirror address, 20 bytes. CCIP receiver.
    pub receiver: [u8; 20],
    /// Gas the destination `ccipReceive` may use.
    pub gas_limit: u64,
    pub bump: u8,
}
