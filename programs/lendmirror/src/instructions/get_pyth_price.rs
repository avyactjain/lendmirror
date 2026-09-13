use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{PythPrice, PythPriceAccount, Store, PYTH_PRICE_SEED, STORE_SEED};

#[derive(Accounts)]
#[instruction(params: GetPythPriceParams)]
pub struct GetPythPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Pyth shard-0 push-feed account. Same `PriceUpdateV2` type as a pull update.
    /// Address: PDA([shard_u16_le, feed_id], pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT)
    /// or the Account Address on https://docs.pyth.network/price-feeds/core/push-feeds/solana
    pub price_feed: Account<'info, PriceUpdateV2>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PythPriceAccount::INIT_SPACE,
        seeds = [PYTH_PRICE_SEED, params.feed_id.as_ref()],
        bump
    )]
    pub price_store: Account<'info, PythPriceAccount>,

    #[account(mut, seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct GetPythPriceParams {
    pub feed_id: [u8; 32],
}

impl GetPythPrice<'_> {
    pub fn get_price_from_pyth(
        ctx: &mut Context<GetPythPrice>,
        params: &GetPythPriceParams,
    ) -> Result<pyth_solana_receiver_sdk::price_update::Price> {
        let price_feed = &ctx.accounts.price_feed;
        // Devnet shard-0 SOL/USD is often days stale. Feed id is still checked.
        let price = price_feed.get_price_unchecked(&params.feed_id)?;

        Ok(price)
    }

    pub fn apply(
        ctx: &mut Context<GetPythPrice>,
        params: &GetPythPriceParams,
    ) -> Result<PythPrice> {
        let price = Self::get_price_from_pyth(ctx, &params)?;

        let pyth_price = PythPrice {
            pyth_account: ctx.accounts.price_feed.key(),
            feed_id: params.feed_id,
            price: price.price,
            conf: price.conf,
            exponent: price.exponent,
            publish_time: price.publish_time,
        };

        ctx.accounts.price_store.price = pyth_price.clone();
        ctx.accounts.store.price_store = Some(pyth_price.clone());

        Ok(pyth_price)
    }
}
