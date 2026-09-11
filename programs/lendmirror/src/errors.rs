use anchor_lang::prelude::error_code;

#[error_code]
pub enum LendMirrorError {
    InvalidJupiterAccount,
    PositionIdMismatch,
    TickPdaMismatch,
    TickOutOfRange,
    Unauthorized,
    AllowlistTooLong,
    NoPositionSnapshot,
}
