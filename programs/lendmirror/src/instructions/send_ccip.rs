use anchor_lang::prelude::*;

/// `sha256("global:ccip_send")[..8]`.
pub const CCIP_SEND_DISCRIMINATOR: [u8; 8] = [108, 216, 134, 191, 249, 234, 33, 84];
/// CCIP router rejects message data above this.
pub const CCIP_DATA_LIMIT: usize = 256;
/// Chainlink `GenericExtraArgsV2` tag. The fee program reads Borsh after it: `u128` gas, then one
/// bool.
const EXTRA_ARGS_V2_TAG: [u8; 4] = [0x18, 0x1d, 0xcf, 0x10];

/// One entry of `SVM2AnyMessage.token_amounts`: which mint and how much (base units).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct CcipTokenAmount {
    pub token: Pubkey,
    pub amount: u64,
}

/// Router `ccip_send` instruction bytes (Anchor discriminator + Borsh args).
///
/// Layout: `dest_chain_selector u64 | SVM2AnyMessage { receiver bytes, data bytes,
/// token_amounts Vec<CcipTokenAmount>, fee_token pubkey, extra_args bytes } | token_indexes bytes`.
/// `fee_token` is the zero key, meaning "pay in native SOL". `token_indexes` says where each
/// token's account slice starts in the remaining accounts (`[0]` for one token).
///
/// Data-only send: `ccip_send_instruction_data(sel, &addr, &body, 400_000, &[], &[])`.
/// Token-only send: `ccip_send_instruction_data(sel, &addr, &[], 0, &[usdc_1e6], &[0])`.
pub fn ccip_send_instruction_data(
    dest_chain_selector: u64,
    receiver: &[u8],
    body: &[u8],
    gas_limit: u64,
    token_amounts: &[CcipTokenAmount],
    token_indexes: &[u8],
) -> Vec<u8> {
    let extra = evm_extra_args_v2(gas_limit);
    let receiver32 = evm_receiver_32(receiver);
    let mut data = Vec::with_capacity(256 + 40 * token_amounts.len());
    data.extend_from_slice(&CCIP_SEND_DISCRIMINATOR);
    data.extend_from_slice(&dest_chain_selector.to_le_bytes());
    push_borsh_bytes(&mut data, &receiver32);
    push_borsh_bytes(&mut data, body);
    data.extend_from_slice(&(token_amounts.len() as u32).to_le_bytes());
    for t in token_amounts {
        t.serialize(&mut data).expect("Vec<u8> writer cannot fail");
    }
    data.extend_from_slice(&[0u8; 32]);
    push_borsh_bytes(&mut data, &extra);
    push_borsh_bytes(&mut data, token_indexes);
    data
}

pub fn evm_extra_args_v2(gas_limit: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(21);
    out.extend_from_slice(&EXTRA_ARGS_V2_TAG);
    out.extend_from_slice(&(gas_limit as u128).to_le_bytes());
    out.push(1);
    out
}

/// Fee program wants a 32-byte receiver: 12 zero bytes, then the 20-byte Ethereum address.
fn evm_receiver_32(receiver: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let start = out.len() - receiver.len();
    out[start..].copy_from_slice(receiver);
    out
}

fn push_borsh_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_args_match_chainlink_v2() {
        let args = evm_extra_args_v2(400_000);
        assert_eq!(args.len(), 21);
        assert_eq!(&args[..4], &[0x18, 0x1d, 0xcf, 0x10]);
        assert_eq!(&args[4..20], &400_000u128.to_le_bytes());
        assert_eq!(args[20], 1);
    }

    #[test]
    fn ccip_data_carries_the_snapshot_body() {
        let body = vec![7u8; 225];
        let receiver = [9u8; 20];
        let data = ccip_send_instruction_data(42, &receiver, &body, 400_000, &[], &[]);
        assert_eq!(&data[..8], &CCIP_SEND_DISCRIMINATOR);
        assert_eq!(&data[8..16], &42u64.to_le_bytes());
        assert_eq!(&data[16..20], &32u32.to_le_bytes());
        assert_eq!(&data[20..32], &[0u8; 12]);
        assert_eq!(&data[32..52], &receiver);
        let body_at = 8 + 8 + 4 + 32 + 4;
        assert_eq!(&data[body_at..body_at + 225], body.as_slice());
        assert!(body.len() <= CCIP_DATA_LIMIT);
        let tokens_at = body_at + 225;
        assert_eq!(&data[tokens_at..tokens_at + 4], &0u32.to_le_bytes(), "no tokens");
        assert_eq!(&data[data.len() - 4..], &0u32.to_le_bytes(), "empty token_indexes");
    }

    #[test]
    fn ccip_token_only_send_carries_the_token_and_index() {
        let mint = Pubkey::new_unique();
        let tokens = [CcipTokenAmount { token: mint, amount: 1_000_000 }];
        let data = ccip_send_instruction_data(42, &[9u8; 20], &[], 0, &tokens, &[0]);
        // 8 disc + 8 selector + (4 + 32) receiver + (4 + 0) data
        let tokens_at = 8 + 8 + 36 + 4;
        assert_eq!(&data[tokens_at..tokens_at + 4], &1u32.to_le_bytes(), "one token");
        assert_eq!(&data[tokens_at + 4..tokens_at + 36], mint.as_ref());
        assert_eq!(&data[tokens_at + 36..tokens_at + 44], &1_000_000u64.to_le_bytes());
        let fee_at = tokens_at + 44;
        assert_eq!(&data[fee_at..fee_at + 32], &[0u8; 32], "native SOL fee");
        let extra_at = fee_at + 32;
        assert_eq!(&data[extra_at..extra_at + 4], &21u32.to_le_bytes());
        assert_eq!(&data[extra_at + 8..extra_at + 24], &0u128.to_le_bytes(), "gas 0 for token-only");
        assert_eq!(&data[data.len() - 5..], &[1, 0, 0, 0, 0], "token_indexes = [0]");
    }
}
