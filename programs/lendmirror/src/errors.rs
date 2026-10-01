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
    /// The position NFT is not in the wrapper's custody.
    NoCustody,
    /// The position NFT is already in custody.
    AlreadyInCustody,
    /// A token account is not the associated token account the program expects.
    InvalidTokenAccount,
    /// The bridge route is disabled by the admin.
    RouteDisabled,
    /// Amount exceeds the route's per-transaction cap.
    AmountTooLarge,
    /// The route is for a different bridge provider than this instruction.
    WrongProvider,
    /// A provider account does not match what the route or the provider program expects.
    InvalidBridgeAccount,
    /// `bridge_tokens_lz`: the next instruction in this transaction is not the issuer's send,
    /// or its program, amount, destination, source account, options or compose do not match.
    MissingBridgeSend,
    /// `swap_to_usdc`: the swap allows more than 1% slippage, or quotes zero out.
    SlippageTooHigh,
}
