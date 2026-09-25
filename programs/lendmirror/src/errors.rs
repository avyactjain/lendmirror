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
    DebtFactorUnderflow,
    DebtFactorOverflow,
    BranchChainTooLong,
    MissingBranchAccount,
    MissingLiquidationRecord,
    InvalidCcipAccount,
    /// This snapshot (same `snapshot_time`) already went out. Run `refresh_wrapper` first.
    SnapshotAlreadySent,
    /// The wrapper's access level does not allow this operation.
    LevelDenied,
    /// Level must be 0..=4.
    InvalidLevel,
}
