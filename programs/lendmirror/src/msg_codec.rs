use anchor_lang::prelude::error_code;

// -----------------------------------------------------------------------------
// LayerZero payload framing: [32-byte length header][payload].
// PositionSnapshot encodes the body; this module wraps/unwraps the header.
// -----------------------------------------------------------------------------

pub const LENGTH_OFFSET: usize = 0;
pub const PAYLOAD_OFFSET: usize = 32;

#[error_code]
pub enum MsgCodecError {
    /// Buffer too short to even contain the 32‐byte length header
    InvalidLength,
    /// Header says "body is N bytes" but buffer < 32+N
    BodyTooShort,
}

/// Extract the payload length from the 32-byte header (last 4 bytes, big endian).
fn decode_payload_len(buf: &[u8]) -> Result<usize, MsgCodecError> {
    if buf.len() < PAYLOAD_OFFSET {
        return Err(MsgCodecError::InvalidLength);
    }
    let mut len_bytes = [0u8; 32];
    len_bytes.copy_from_slice(&buf[LENGTH_OFFSET..LENGTH_OFFSET + 32]);
    Ok(u32::from_be_bytes(len_bytes[28..32].try_into().unwrap()) as usize)
}

/// [32-byte length header][payload]
pub fn wrap_lz_payload(payload: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(PAYLOAD_OFFSET + payload.len());
    msg.extend(std::iter::repeat(0).take(28));
    msg.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    msg.extend_from_slice(payload);
    msg
}

/// Strip the 32-byte header. Extra bytes after the declared payload are ignored.
pub fn unwrap_lz_payload(buf: &[u8]) -> Result<&[u8], MsgCodecError> {
    let payload_len = decode_payload_len(buf)?;
    let start = PAYLOAD_OFFSET;
    let end = start
        .checked_add(payload_len)
        .ok_or(MsgCodecError::InvalidLength)?;
    if end > buf.len() {
        return Err(MsgCodecError::BodyTooShort);
    }
    Ok(&buf[start..end])
}

/// Pack a value into LayerZero payload bytes (and unpack on the other side).
/// Impl this on any type you want to send. `SendMessageParams.message` stores
/// those bytes — Anchor instruction data cannot be generic over `M`.
pub trait LzMessage: Sized {
    fn encode(&self) -> Vec<u8>;
    fn decode(buf: &[u8]) -> std::result::Result<Self, MsgCodecError>;
}

/// Already-encoded payload (what the `send` / `quote_send` instructions carry).
impl LzMessage for Vec<u8> {
    fn encode(&self) -> Vec<u8> {
        self.clone()
    }

    fn decode(buf: &[u8]) -> std::result::Result<Self, MsgCodecError> {
        Ok(buf.to_vec())
    }
}
