use anchor_lang::prelude::error_code;
use std::str;

// -----------------------------------------------------------------------------
// This file defines how the example program encodes and decodes its messages.
// Each OApp can implement its own layout as long as the sending and receiving
// chains agree.  Here we simply prefix a UTF-8 string with a 32 byte length
// header. In this example, the EVM-side equivalant is in `contracts/libs/StringMsgCodec.sol`
// -----------------------------------------------------------------------------


// The message is a UTF-8 encoded string prefixed with a 32 byte header.
// The following is the layout of the message:
// Offset →
// 0                     28     32                     32+N
// |---------------------|------|---------------------------->
// |     28 bytes        | 4B   |     N bytes                |
// |    zero padding     | len  | UTF-8 encoded string       |
// |---------------------|------|----------------------------|


// We prefix the encoded string with a 32 byte length header.
pub const LENGTH_OFFSET: usize = 0;
pub const STRING_OFFSET: usize = 32;

#[error_code]
pub enum MsgCodecError {
    /// Buffer too short to even contain the 32‐byte length header
    InvalidLength,
    /// Header says "string is N bytes" but buffer < 32+N
    BodyTooShort,
    /// Payload bytes aren’t valid UTF-8
    InvalidUtf8,
}

/// Extract the payload length from the 32-byte header (last 4 bytes, big endian).
fn decode_payload_len(buf: &[u8]) -> Result<usize, MsgCodecError> {
    if buf.len() < STRING_OFFSET {
        return Err(MsgCodecError::InvalidLength);
    }
    let mut len_bytes = [0u8; 32];
    len_bytes.copy_from_slice(&buf[LENGTH_OFFSET..LENGTH_OFFSET + 32]);
    Ok(u32::from_be_bytes(len_bytes[28..32].try_into().unwrap()) as usize)
}

/// [32-byte length header][payload]
pub fn wrap_lz_payload(payload: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(STRING_OFFSET + payload.len());
    msg.extend(std::iter::repeat(0).take(28));
    msg.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    msg.extend_from_slice(payload);
    msg
}

/// Strip the 32-byte header. Extra bytes after the declared payload are ignored.
pub fn unwrap_lz_payload(buf: &[u8]) -> Result<&[u8], MsgCodecError> {
    let payload_len = decode_payload_len(buf)?;
    let start = STRING_OFFSET;
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

impl LzMessage for String {
    fn encode(&self) -> Vec<u8> {
        encode(self)
    }

    fn decode(buf: &[u8]) -> std::result::Result<Self, MsgCodecError> {
        decode(buf)
    }
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

// Encode a UTF-8 string into a message format with a 32 byte header
pub fn encode(string: &str) -> Vec<u8> {
    wrap_lz_payload(string.as_bytes())
}

// Decode a message format with a 32 byte header into a UTF-8 string
// Returns an error if the message is malformed or not valid UTF-8
pub fn decode(message: &[u8]) -> Result<String, MsgCodecError> {
    let payload = unwrap_lz_payload(message)?;
    match str::from_utf8(payload) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => Err(MsgCodecError::InvalidUtf8),
    }
}
