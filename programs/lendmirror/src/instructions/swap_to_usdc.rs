//! `swap_to_usdc`: swap a token the wrapper holds into one we can bridge, through Jupiter.
//!
//! Why it exists: PST has no bridge to Arbitrum on any provider, so it can only travel as USDC.
//! The swap happens inside program custody: in from the wrapper authority's token account, out
//! into the wrapper authority's token account of the destination mint. From there the normal
//! `bridge_tokens_cctp` takes over. Nothing ever sits in a wallet.
//!
//! Owns: the checks around a forwarded Jupiter v6 `route` call. Does NOT own: routing (the
//! client asks Jupiter's swap API, single direct route, no shared accounts) or bridging.
//!
//! Invariants (fund safety):
//!   - Jupiter's `user_transfer_authority`, source and destination accounts are pinned to the
//!     wrapper authority PDA and its two token accounts. Output cannot land anywhere else.
//!   - The destination mint must have an enabled `BridgeRoute`, so a swap can only produce a
//!     token whose only exit is our own treasury.
//!   - Only the Store admin or a sender (operator) may call. A swap's price is set off-chain by
//!     the quote, so this is an operator action, not something a wrapper owner may trigger.
//!   - `slippage_bps` is capped at 1% and the platform fee must be zero.
//!
//! Call depth: us (1) → Jupiter (2) → the pool program (3) → token program (4). Fits.
//!
//! Typical call: hardhat `lz:oapp:solana:swap-to-usdc --mint PST --amount 1000000`.

use crate::errors::LendMirrorError;
use crate::seeds::{ONDEMAND_SEED, STORE_SEED, WRAPPER_AUTH_SEED, WRAPPER_SEED};
use crate::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, pubkey};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

/// Jupiter v6 aggregator. Fixed: it is the only swap program we forward to.
pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// `sha256("global:route")[..8]`: Jupiter v6's plain `route` instruction. The shared-accounts
/// variants move tokens through Jupiter's own accounts, which would break the custody pin, so
/// only this one is accepted (the client asks the swap API for it: `useSharedAccounts: false`).
pub const JUPITER_ROUTE_DISCRIMINATOR: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];

/// Positions of Jupiter `route`'s named accounts (its IDL order). The pool accounts follow.
mod route_slot {
    /// Signs the transfer out of the source account: must be the wrapper authority.
    pub const USER_TRANSFER_AUTHORITY: usize = 1;
    /// Where Jupiter pulls the input: must be the wrapper authority's source token account.
    pub const USER_SOURCE: usize = 2;
    /// Where the output lands: must be the wrapper authority's destination token account.
    pub const USER_DESTINATION: usize = 3;
    /// Optional override of the output account. Absent (= the Jupiter program id) or the same
    /// destination; anything else would move the output elsewhere.
    pub const DESTINATION_OVERRIDE: usize = 4;
    pub const DESTINATION_MINT: usize = 5;
    /// Optional fee account. Must be absent: the platform fee is required to be zero.
    pub const PLATFORM_FEE: usize = 6;
    /// How many named accounts `route` has before the pool accounts.
    pub const NAMED: usize = 9;
}

#[derive(Accounts)]
pub struct SwapToUsdc<'info> {
    /// Operator: the Store admin or a sender. Pays rent for `destination_ata` if it is new.
    #[account(
        mut,
        constraint = (
            store.admin == authority.key() || store.is_sender(&authority.key())
        ) @ LendMirrorError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Box<Account<'info, Store>>,

    // The wrapper whose tokens are swapped. Same level rule as bridging.
    #[account(
        seeds = [
            WRAPPER_SEED,
            &wrapper.vault_id.to_le_bytes(),
            &wrapper.nft_id.to_le_bytes()
        ],
        bump = wrapper.bump,
        constraint = (
            wrapper.level == LEVEL_DEPOSIT_PAYBACK || wrapper.level == LEVEL_WITHDRAW_BORROW
        ) @ LendMirrorError::LevelDenied
    )]
    pub wrapper: Box<Account<'info, PositionWrapper>>,

    #[account(
        seeds = [ONDEMAND_SEED, wrapper.key().as_ref()],
        bump = ondemand.bump,
        constraint = ondemand.wrapper == wrapper.key() @ LendMirrorError::Unauthorized
    )]
    pub ondemand: Option<Box<Account<'info, OnDemandStrategy>>>,

    /// CHECK: empty PDA that owns both token accounts. Signs for Jupiter via `invoke_signed`.
    #[account(seeds = [WRAPPER_AUTH_SEED, wrapper.key().as_ref()], bump = wrapper.authority_bump)]
    pub wrapper_authority: UncheckedAccount<'info>,

    /// The token being sold (PST).
    #[account(mint::token_program = source_token_program)]
    pub source_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The token being bought. Must have an enabled bridge route: swaps may only produce a
    /// token that can leave through our own treasury.
    #[account(mint::token_program = destination_token_program)]
    pub destination_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        constraint = destination_route.mint == destination_mint.key() @ LendMirrorError::InvalidBridgeAccount,
        constraint = destination_route.enabled @ LendMirrorError::RouteDisabled
    )]
    pub destination_route: Box<Account<'info, BridgeRoute>>,

    #[account(
        mut,
        associated_token::mint = source_mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = source_token_program
    )]
    pub source_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = destination_mint,
        associated_token::authority = wrapper_authority,
        associated_token::token_program = destination_token_program
    )]
    pub destination_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Jupiter v6, fixed program id.
    #[account(address = JUPITER_V6)]
    pub jupiter_program: UncheckedAccount<'info>,

    pub source_token_program: Interface<'info, TokenInterface>,
    pub destination_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SwapToUsdcParams {
    /// Jupiter's `route` instruction bytes, exactly as its swap API returned them. The route
    /// plan inside is Jupiter's business; the fields we police sit at fixed offsets.
    pub data: Vec<u8>,
}

/// The fixed-size tail of Jupiter `route`'s arguments: the route plan is variable-length and
/// comes first, these four always end the data.
pub struct RouteArgsTail {
    pub in_amount: u64,
    pub quoted_out_amount: u64,
    pub slippage_bps: u16,
    pub platform_fee_bps: u8,
}

/// Read the tail out of `route` instruction data. `None` if this is not a plain `route` call.
pub fn parse_route_args_tail(data: &[u8]) -> Option<RouteArgsTail> {
    if data.len() < 8 + 19 || data[..8] != JUPITER_ROUTE_DISCRIMINATOR {
        return None;
    }
    let tail = &data[data.len() - 19..];
    Some(RouteArgsTail {
        in_amount: u64::from_le_bytes(tail[0..8].try_into().unwrap()),
        quoted_out_amount: u64::from_le_bytes(tail[8..16].try_into().unwrap()),
        slippage_bps: u16::from_le_bytes(tail[16..18].try_into().unwrap()),
        platform_fee_bps: tail[18],
    })
}

impl<'info> SwapToUsdc<'info> {
    pub fn apply(
        ctx: &mut Context<'_, '_, '_, 'info, SwapToUsdc<'info>>,
        params: &SwapToUsdcParams,
    ) -> Result<()> {
        let a = &ctx.accounts;
        let jupiter = ctx.remaining_accounts;
        require!(jupiter.len() >= route_slot::NAMED, LendMirrorError::InvalidJupiterAccount);

        let args = parse_route_args_tail(&params.data).ok_or(LendMirrorError::InvalidJupiterAccount)?;
        require!(args.platform_fee_bps == 0, LendMirrorError::InvalidJupiterAccount);
        require!(args.slippage_bps <= 100, LendMirrorError::SlippageTooHigh);
        require!(args.quoted_out_amount > 0, LendMirrorError::SlippageTooHigh);
        require!(args.in_amount > 0, LendMirrorError::AmountTooLarge);
        require!(args.in_amount <= a.source_ata.amount, LendMirrorError::AmountTooLarge);

        // Pin Jupiter's named accounts to the wrapper authority and its token accounts.
        let slot = |i: usize| jupiter[i].key();
        require_keys_eq!(slot(route_slot::USER_TRANSFER_AUTHORITY), a.wrapper_authority.key(), LendMirrorError::InvalidJupiterAccount);
        require_keys_eq!(slot(route_slot::USER_SOURCE), a.source_ata.key(), LendMirrorError::InvalidJupiterAccount);
        require_keys_eq!(slot(route_slot::USER_DESTINATION), a.destination_ata.key(), LendMirrorError::InvalidJupiterAccount);
        require!(
            slot(route_slot::DESTINATION_OVERRIDE) == JUPITER_V6
                || slot(route_slot::DESTINATION_OVERRIDE) == a.destination_ata.key(),
            LendMirrorError::InvalidJupiterAccount
        );
        require_keys_eq!(slot(route_slot::DESTINATION_MINT), a.destination_mint.key(), LendMirrorError::InvalidJupiterAccount);
        require_keys_eq!(slot(route_slot::PLATFORM_FEE), JUPITER_V6, LendMirrorError::InvalidJupiterAccount);

        // Forward. Every account keeps its writability; only the wrapper authority signs.
        let authority = a.wrapper_authority.key();
        let metas = jupiter
            .iter()
            .map(|info| AccountMeta { pubkey: info.key(), is_signer: info.key() == authority, is_writable: info.is_writable })
            .collect();
        let mut infos = jupiter.to_vec();
        infos.push(a.jupiter_program.to_account_info());
        let wrapper_key = a.wrapper.key();
        let seeds: &[&[u8]] = &[WRAPPER_AUTH_SEED, wrapper_key.as_ref(), &[a.wrapper.authority_bump]];
        invoke_signed(
            &Instruction { program_id: JUPITER_V6, accounts: metas, data: params.data.clone() },
            &infos,
            &[seeds],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jupiter `route` data with an empty route plan: discriminator, `0u32` (plan length),
    /// then the four tail fields.
    fn route_data(in_amount: u64, quoted_out: u64, slippage_bps: u16, fee_bps: u8) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&JUPITER_ROUTE_DISCRIMINATOR);
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&in_amount.to_le_bytes());
        data.extend_from_slice(&quoted_out.to_le_bytes());
        data.extend_from_slice(&slippage_bps.to_le_bytes());
        data.push(fee_bps);
        data
    }

    #[test]
    fn tail_parses_from_the_end_whatever_the_plan_length() {
        for extra in [0usize, 7, 40] {
            let mut data = route_data(5_000_000, 5_600_000, 50, 0);
            // A longer route plan only moves the tail further out; fake that with padding
            // inserted after the plan length.
            let tail_start = data.len() - 19;
            data.splice(12..12, std::iter::repeat_n(0xEE, extra));
            assert_eq!(data.len() - 19, tail_start + extra);
            let args = parse_route_args_tail(&data).expect("must parse");
            assert_eq!(args.in_amount, 5_000_000);
            assert_eq!(args.quoted_out_amount, 5_600_000);
            assert_eq!(args.slippage_bps, 50);
            assert_eq!(args.platform_fee_bps, 0);
        }
    }

    #[test]
    fn tail_rejects_wrong_or_short_data() {
        assert!(parse_route_args_tail(&[]).is_none(), "empty");
        let mut data = route_data(1, 1, 1, 0);
        data[0] ^= 1;
        assert!(parse_route_args_tail(&data).is_none(), "wrong discriminator");
        let short = &route_data(1, 1, 1, 0)[..20];
        assert!(parse_route_args_tail(short).is_none(), "shorter than the tail");
    }
}
