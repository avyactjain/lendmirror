//! Byte-level builders for the bridge providers' Solana instructions.
//!
//! Owns: instruction DATA (discriminator + Borsh args) for Circle CCTP v2 `deposit_for_burn` and
//! for a LayerZero OFT `send`. The Chainlink `ccip_send` builder lives in
//! `instructions/send_ccip.rs` because the data-only send already used it. Does NOT own: account
//! lists (see `instructions/bridge_tokens.rs`).
//!
//! Everything here is a pure function over plain values, so it is unit-tested byte by byte.

use anchor_lang::prelude::*;

/// `sha256("global:deposit_for_burn")[..8]` of Circle's TokenMessengerMinterV2 (from its IDL).
pub const CCTP_DEPOSIT_FOR_BURN_DISCRIMINATOR: [u8; 8] = [215, 60, 61, 46, 114, 55, 128, 176];

/// CCTP v2 "standard" finality: no fast-transfer fee, ~13 minutes from Ethereum finality.
/// The caller passes the threshold in `BridgeTokensParams`; these two are the documented values.
#[allow(dead_code)]
pub const CCTP_FINALITY_STANDARD: u32 = 2000;
/// CCTP v2 "fast" finality: Circle attests in seconds and charges `max_fee`.
#[allow(dead_code)]
pub const CCTP_FINALITY_FAST: u32 = 1000;

/// Circle's `DepositForBurnParams`, in IDL order. Borsh encodes it field by field.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CctpDepositForBurnParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

/// Instruction bytes for `deposit_for_burn`.
///
/// `cctp_deposit_for_burn_data(1_000_000, 0, r, c, 0, 2000)` is 8 + 8 + 4 + 32 + 32 + 8 + 4
/// = 96 bytes: discriminator, then 1_000_000 as little-endian u64, then domain 0, ...
pub fn cctp_deposit_for_burn_data(
    amount: u64,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    destination_caller: [u8; 32],
    max_fee: u64,
    min_finality_threshold: u32,
) -> Vec<u8> {
    let params = CctpDepositForBurnParams {
        amount,
        destination_domain,
        mint_recipient: Pubkey::new_from_array(mint_recipient),
        destination_caller: Pubkey::new_from_array(destination_caller),
        max_fee,
        min_finality_threshold,
    };
    let mut data = Vec::with_capacity(96);
    data.extend_from_slice(&CCTP_DEPOSIT_FOR_BURN_DISCRIMINATOR);
    params.serialize(&mut data).expect("Vec<u8> writer cannot fail");
    data
}

/// `sha256("global:send")[..8]`: the `send` instruction of LayerZero's OFT program.
pub const OFT_SEND_DISCRIMINATOR: [u8; 8] = [102, 251, 20, 187, 65, 75, 12, 69];

/// LayerZero OFT `SendParams`, in the order the OFT program declares them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OftSendParams {
    /// LayerZero endpoint id of the destination (Arbitrum 30110, Ethereum 30101).
    pub dst_eid: u32,
    /// Receiver on the destination, 32 bytes (EVM address left-padded).
    pub to: [u8; 32],
    /// Amount in local decimals ("ld").
    pub amount_ld: u64,
    /// Least amount that may arrive after the OFT drops dust below its shared decimals.
    pub min_amount_ld: u64,
    /// Executor options (gas on the destination). Combined with the peer's enforced options.
    pub options: Vec<u8>,
    /// We never compose: the treasury has no `lzCompose`.
    pub compose_msg: Option<Vec<u8>>,
    /// LayerZero fee in lamports, from the OFT's `quote_send`.
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

/// Instruction bytes for an OFT `send` with no compose message.
///
/// `oft_send_data(30110, r, 1_000_000, 1_000_000, &[], 5_000_000)` → discriminator, then
/// `30110u32` LE, `r`, two `u64`s, an empty vec (`0u32`), `0` (None), the fee, and `0u64`.
pub fn oft_send_data(
    dst_eid: u32,
    to: [u8; 32],
    amount_ld: u64,
    min_amount_ld: u64,
    options: &[u8],
    native_fee: u64,
) -> Vec<u8> {
    let params = OftSendParams {
        dst_eid,
        to,
        amount_ld,
        min_amount_ld,
        options: options.to_vec(),
        compose_msg: None,
        native_fee,
        lz_token_fee: 0,
    };
    let mut data = Vec::with_capacity(8 + 4 + 32 + 8 + 8 + 4 + options.len() + 1 + 8 + 8);
    data.extend_from_slice(&OFT_SEND_DISCRIMINATOR);
    params.serialize(&mut data).expect("Vec<u8> writer cannot fail");
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oft_send_bytes_follow_the_oft_program_order() {
        let to = [0xCCu8; 32];
        let data = oft_send_data(30110, to, 1_000_000, 999_000, &[1, 2, 3], 5_000_000);
        assert_eq!(&data[..8], &OFT_SEND_DISCRIMINATOR);
        assert_eq!(&data[8..12], &30110u32.to_le_bytes(), "dst_eid");
        assert_eq!(&data[12..44], &to);
        assert_eq!(&data[44..52], &1_000_000u64.to_le_bytes(), "amount_ld");
        assert_eq!(&data[52..60], &999_000u64.to_le_bytes(), "min_amount_ld");
        assert_eq!(&data[60..64], &3u32.to_le_bytes(), "options length");
        assert_eq!(&data[64..67], &[1, 2, 3]);
        assert_eq!(data[67], 0, "compose_msg = None");
        assert_eq!(&data[68..76], &5_000_000u64.to_le_bytes(), "native_fee");
        assert_eq!(&data[76..84], &0u64.to_le_bytes(), "lz_token_fee");
        assert_eq!(data.len(), 84);
    }

    #[test]
    fn deposit_for_burn_bytes_follow_the_idl_order() {
        let recipient = [0xAAu8; 32];
        let caller = [0xBBu8; 32];
        let data = cctp_deposit_for_burn_data(1_000_000, 3, recipient, caller, 7, CCTP_FINALITY_STANDARD);
        assert_eq!(data.len(), 96);
        assert_eq!(&data[..8], &CCTP_DEPOSIT_FOR_BURN_DISCRIMINATOR);
        assert_eq!(&data[8..16], &1_000_000u64.to_le_bytes());
        assert_eq!(&data[16..20], &3u32.to_le_bytes(), "destination_domain = Arbitrum");
        assert_eq!(&data[20..52], &recipient);
        assert_eq!(&data[52..84], &caller);
        assert_eq!(&data[84..92], &7u64.to_le_bytes(), "max_fee");
        assert_eq!(&data[92..96], &2000u32.to_le_bytes(), "standard finality");
    }
}
