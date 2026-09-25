/// `sha256("global:ccip_send")[..8]`.
pub const CCIP_SEND_DISCRIMINATOR: [u8; 8] = [108, 216, 134, 191, 249, 234, 33, 84];
/// CCIP router rejects message data above this.
pub const CCIP_DATA_LIMIT: usize = 256;
/// Chainlink `GenericExtraArgsV2` tag. The fee program reads Borsh after it: `u128` gas, then one
/// bool.
const EXTRA_ARGS_V2_TAG: [u8; 4] = [0x18, 0x1d, 0xcf, 0x10];

/// Router instruction bytes for a snapshot body and no token transfer.
pub fn ccip_send_instruction_data(
    dest_chain_selector: u64,
    receiver: &[u8],
    body: &[u8],
    gas_limit: u64,
) -> Vec<u8> {
    let extra = evm_extra_args_v2(gas_limit);
    let receiver32 = evm_receiver_32(receiver);
    let mut data = Vec::with_capacity(256);
    data.extend_from_slice(&CCIP_SEND_DISCRIMINATOR);
    data.extend_from_slice(&dest_chain_selector.to_le_bytes());
    push_borsh_bytes(&mut data, &receiver32);
    push_borsh_bytes(&mut data, body);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&[0u8; 32]);
    push_borsh_bytes(&mut data, &extra);
    data.extend_from_slice(&0u32.to_le_bytes());
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
        let data = ccip_send_instruction_data(42, &receiver, &body, 400_000);
        assert_eq!(&data[..8], &CCIP_SEND_DISCRIMINATOR);
        assert_eq!(&data[8..16], &42u64.to_le_bytes());
        assert_eq!(&data[16..20], &32u32.to_le_bytes());
        assert_eq!(&data[20..32], &[0u8; 12]);
        assert_eq!(&data[32..52], &receiver);
        let body_at = 8 + 8 + 4 + 32 + 4;
        assert_eq!(&data[body_at..body_at + 225], body.as_slice());
        assert!(body.len() <= CCIP_DATA_LIMIT);
    }
}
