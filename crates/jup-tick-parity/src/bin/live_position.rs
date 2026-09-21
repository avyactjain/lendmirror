//! Run the program's live-position math on a real NFT.
//!
//! Prints one JSON object. The TypeScript test compares it to Jupiter.

use anchor_lang::prelude::Pubkey;
use lendmirror::tick_math::{
    debt_raw_at_tick, liquidation_debt_raw_at_tick, normalize_tick, tick_pda_seed, MIN_TICK,
};
use lendmirror::{
    branch_address, decode_branch, decode_position, decode_tick, decode_tick_id_liquidation,
    liquidation_record, tick_id_liquidation_address, walk_branches, Branch, JUPITER_VAULTS_MAINNET,
};
use solana_client::rpc_client::RpcClient;

fn main() {
    let mut args = std::env::args().skip(1);
    let vault_id: u16 = args.next().expect("vault id").parse().expect("vault id");
    let nft_id: u32 = args.next().expect("nft id").parse().expect("nft id");
    let rpc = std::env::var("RPC_URL_SOLANA").expect("RPC_URL_SOLANA");
    let client = RpcClient::new(rpc);

    let (position_key, _) = Pubkey::find_program_address(
        &[b"position", &vault_id.to_le_bytes(), &nft_id.to_le_bytes()],
        &JUPITER_VAULTS_MAINNET,
    );
    let position_account = client
        .get_account(&sdk_key(position_key))
        .unwrap_or_else(|e| panic!("no Position at {position_key}: {e}"));
    let position = decode_position(&position_account.data).expect("decode Position");
    assert_eq!(position.vault_id, vault_id);
    assert_eq!(position.nft_id, nft_id);

    let (tick_key, _) = Pubkey::find_program_address(
        &[b"tick", &vault_id.to_le_bytes(), &tick_pda_seed(position.tick)],
        &JUPITER_VAULTS_MAINNET,
    );
    let tick_account = client
        .get_account(&sdk_key(tick_key))
        .unwrap_or_else(|e| panic!("no Tick at {tick_key}: {e}"));
    let tick = decode_tick(&tick_account.data).expect("decode Tick");

    let is_supply_only = position.is_supply_only_position != 0;
    let stored_tick = normalize_tick(position.tick);
    let is_liquidated =
        !is_supply_only && (tick.is_liquidated != 0 || tick.total_ids > position.tick_id);
    let mut dust_debt = position.dust_debt_amount;
    let stored_debt = if is_supply_only {
        0
    } else {
        debt_raw_at_tick(position.tick, position.supply_amount).expect("debt")
    };

    let mut live_tick = stored_tick;
    let mut col_raw = position.supply_amount;
    let mut debt_raw = stored_debt;
    let mut fully = false;

    if is_liquidated {
        let flushed = if tick.total_ids == position.tick_id {
            None
        } else {
            let key = tick_id_liquidation_address(
                &JUPITER_VAULTS_MAINNET,
                vault_id,
                stored_tick,
                position.tick_id,
            );
            let account = client
                .get_account(&sdk_key(key))
                .unwrap_or_else(|e| panic!("no TickIdLiquidation at {key}: {e}"));
            Some(decode_tick_id_liquidation(&account.data).expect("decode TickIdLiquidation"))
        };
        let record = liquidation_record(position.tick_id, &tick, flushed.as_ref());
        if record.is_fully_liquidated {
            live_tick = MIN_TICK;
            col_raw = 0;
            debt_raw = 0;
            dust_debt = 0;
            fully = true;
        } else {
            let start_debt =
                liquidation_debt_raw_at_tick(position.tick, position.supply_amount).expect("debt");
            let live = walk_branches(
                record.branch_id,
                record.connection_factor,
                start_debt,
                |branch_id| {
                    let key = branch_address(&JUPITER_VAULTS_MAINNET, vault_id, branch_id);
                    let account = client
                        .get_account(&sdk_key(key))
                        .unwrap_or_else(|e| panic!("no Branch {branch_id} at {key}: {e}"));
                    let decoded = decode_branch(&account.data).expect("decode Branch");
                    Ok(Branch {
                        status: decoded.status,
                        minima_tick: decoded.minima_tick,
                        minima_tick_partials: decoded.minima_tick_partials,
                        debt_factor: decoded.debt_factor,
                        connected_branch_id: decoded.connected_branch_id,
                    })
                },
            )
            .expect("branch walk");
            live_tick = live.tick;
            col_raw = live.col_raw;
            debt_raw = live.debt_raw;
        }
    }

    if col_raw == 0 && debt_raw == 0 && is_liquidated {
        fully = true;
    }

    println!(
        "{{\"tick\":{live_tick},\"colRaw\":\"{col_raw}\",\"debtRaw\":\"{debt_raw}\",\"dustDebt\":\"{dust_debt}\",\"isSupplyOnly\":{is_supply_only},\"isLiquidated\":{is_liquidated},\"isFullyLiquidated\":{fully}}}"
    );
}

fn sdk_key(key: Pubkey) -> solana_pubkey::Pubkey {
    solana_pubkey::Pubkey::new_from_array(key.to_bytes())
}
