use crate::*;
use crate::msg_codec::{unwrap_lz_payload, wrap_lz_payload, LzMessage, MsgCodecError};

/// Packed body (no 8-byte Anchor discriminator):
/// pyth_account 32 | feed_id 32 | price i64 | conf u64 | exponent i32 | publish_time i64
/// Integers are big-endian. Wrapped in the same 32-byte length header as strings.
pub const PYTH_PRICE_BODY_LEN: usize = 32 + 32 + 8 + 8 + 4 + 8;

/// Snapshot value. Lives in Store and in the LayerZero payload.
/// Not an account by itself.
#[derive(Clone, InitSpace, AnchorSerialize, AnchorDeserialize)]
pub struct PythPrice {
    pub pyth_account: Pubkey,
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Per-feed PDA: seeds = [PYTH_PRICE_SEED, feed_id]
#[account]
#[derive(InitSpace)]
pub struct PythPriceAccount {
    pub price: PythPrice,
}

impl LzMessage for PythPrice {
    fn encode(&self) -> Vec<u8> {
        let mut body = Vec::with_capacity(PYTH_PRICE_BODY_LEN);
        body.extend_from_slice(self.pyth_account.as_ref());
        body.extend_from_slice(&self.feed_id);
        body.extend_from_slice(&self.price.to_be_bytes());
        body.extend_from_slice(&self.conf.to_be_bytes());
        body.extend_from_slice(&self.exponent.to_be_bytes());
        body.extend_from_slice(&self.publish_time.to_be_bytes());
        wrap_lz_payload(&body)
    }

    fn decode(buf: &[u8]) -> std::result::Result<Self, MsgCodecError> {
        let body = unwrap_lz_payload(buf)?;
        if body.len() != PYTH_PRICE_BODY_LEN {
            return Err(MsgCodecError::BodyTooShort);
        }

        let pyth_account =
            Pubkey::try_from(&body[0..32]).map_err(|_| MsgCodecError::InvalidLength)?;
        let mut feed_id = [0u8; 32];
        feed_id.copy_from_slice(&body[32..64]);

        Ok(Self {
            pyth_account,
            feed_id,
            price: i64::from_be_bytes(body[64..72].try_into().unwrap()),
            conf: u64::from_be_bytes(body[72..80].try_into().unwrap()),
            exponent: i32::from_be_bytes(body[80..84].try_into().unwrap()),
            publish_time: i64::from_be_bytes(body[84..92].try_into().unwrap()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg_codec::LzMessage;

    #[test]
    fn pyth_price_roundtrip() {
        let original = PythPrice {
            pyth_account: Pubkey::new_unique(),
            feed_id: [7u8; 32],
            price: -123,
            conf: 4,
            exponent: -8,
            publish_time: 1_700_000_000,
        };
        let encoded = original.encode();
        let decoded = PythPrice::decode(&encoded).unwrap();
        assert_eq!(original.pyth_account, decoded.pyth_account);
        assert_eq!(original.feed_id, decoded.feed_id);
        assert_eq!(original.price, decoded.price);
        assert_eq!(original.conf, decoded.conf);
        assert_eq!(original.exponent, decoded.exponent);
        assert_eq!(original.publish_time, decoded.publish_time);
        assert_eq!(PYTH_PRICE_BODY_LEN, PythPrice::INIT_SPACE);
        assert_eq!(encoded.len(), 32 + PYTH_PRICE_BODY_LEN);
        assert_eq!(&encoded[28..32], &(PYTH_PRICE_BODY_LEN as u32).to_be_bytes());
        assert_eq!(&encoded[32..64], original.pyth_account.as_ref());
        assert_eq!(&encoded[64..96], &original.feed_id);
        assert_eq!(&encoded[96..104], &original.price.to_be_bytes());
        assert_eq!(&encoded[104..112], &original.conf.to_be_bytes());
        assert_eq!(&encoded[112..116], &original.exponent.to_be_bytes());
        assert_eq!(&encoded[116..124], &original.publish_time.to_be_bytes());
    }
}
