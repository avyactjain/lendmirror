use crate::errors::LendMirrorError;
use anchor_lang::prelude::*;

/// Known Jupiter Lend Vaults ids. Pass one of these into `init_store`.
#[allow(dead_code)]
pub const JUPITER_VAULTS_MAINNET: Pubkey =
    pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");
#[allow(dead_code)]
pub const JUPITER_VAULTS_DEVNET: Pubkey =
    pubkey!("Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu");

const POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const TICK_DISC: [u8; 8] = [176, 94, 67, 247, 133, 173, 7, 115];
const VAULT_STATE_DISC: [u8; 8] = [228, 196, 82, 165, 98, 210, 235, 152];
const VAULT_CONFIG_DISC: [u8; 8] = [99, 86, 43, 216, 184, 102, 119, 77];

/// Packed Jupiter Position body (after 8-byte discriminator). From Vaults IDL.
#[derive(Clone, Debug)]
pub struct JupiterPosition {
    pub vault_id: u16,
    pub nft_id: u32,
    pub position_mint: Pubkey,
    pub is_supply_only_position: u8,
    pub tick: i32,
    pub tick_id: u32,
    pub supply_amount: u64,
    pub dust_debt_amount: u64,
}

/// Packed Jupiter Tick body.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct JupiterTick {
    pub vault_id: u16,
    pub tick: i32,
    pub is_liquidated: u8,
    pub total_ids: u32,
    pub raw_debt: u64,
    pub is_fully_liquidated: u8,
    pub liquidation_branch_id: u32,
    pub debt_factor: u64,
}

#[derive(Clone, Debug)]
pub struct JupiterVaultStatePrices {
    pub vault_supply_exchange_price: u64,
    pub vault_borrow_exchange_price: u64,
}

#[derive(Clone, Debug)]
pub struct JupiterVaultTokens {
    pub supply_token: Pubkey,
    pub borrow_token: Pubkey,
}

/// Snapshot we store. Not a Jupiter account.
#[derive(Clone, InitSpace, AnchorSerialize, AnchorDeserialize)]
pub struct PositionSnapshot {
    pub position: Pubkey,
    pub vault_id: u16,
    pub nft_id: u32,
    pub position_mint: Pubkey,
    pub supply_token: Pubkey,
    pub borrow_token: Pubkey,
    pub col_raw: u64,
    pub debt_raw: u64,
    pub dust_debt: u64,
    pub net_debt: u64,
    pub tick: i32,
    pub tick_id: u32,
    pub is_supply_only: bool,
    pub is_liquidated: bool,
    pub vault_supply_exchange_price: u64,
    pub vault_borrow_exchange_price: u64,
    pub snapshot_time: i64,
}

/// Per-position PDA: seeds = [JUP_POSITION_SEED, vault_id le, nft_id le]
#[account]
#[derive(InitSpace)]
pub struct PositionSnapshotAccount {
    pub snapshot: PositionSnapshot,
}

pub fn decode_position(data: &[u8]) -> Result<JupiterPosition> {
    let mut r = ByteReader::after_disc(data, POSITION_DISC)?;
    Ok(JupiterPosition {
        vault_id: r.u16()?,
        nft_id: r.u32()?,
        position_mint: r.pubkey()?,
        is_supply_only_position: r.u8()?,
        tick: r.i32()?,
        tick_id: r.u32()?,
        supply_amount: r.u64()?,
        dust_debt_amount: r.u64()?,
    })
}

pub fn decode_tick(data: &[u8]) -> Result<JupiterTick> {
    let mut r = ByteReader::after_disc(data, TICK_DISC)?;
    Ok(JupiterTick {
        vault_id: r.u16()?,
        tick: r.i32()?,
        is_liquidated: r.u8()?,
        total_ids: r.u32()?,
        raw_debt: r.u64()?,
        is_fully_liquidated: r.u8()?,
        liquidation_branch_id: r.u32()?,
        debt_factor: r.u64()?,
    })
}

pub fn decode_vault_state_prices(data: &[u8]) -> Result<JupiterVaultStatePrices> {
    let mut r = ByteReader::after_disc(data, VAULT_STATE_DISC)?;
    r.u16()?; // vault_id
    r.u8()?; // branch_liquidated
    r.i32()?; // topmost_tick
    r.u32()?; // current_branch_id
    r.u32()?; // total_branch_id
    r.u64()?; // total_supply
    r.u64()?; // total_borrow
    r.u32()?; // total_positions
    r.u128()?; // absorbed_debt_amount
    r.u128()?; // absorbed_col_amount
    r.u64()?; // absorbed_dust_debt
    r.u64()?; // liquidity_supply_exchange_price
    r.u64()?; // liquidity_borrow_exchange_price
    let vault_supply_exchange_price = r.u64()?;
    let vault_borrow_exchange_price = r.u64()?;
    Ok(JupiterVaultStatePrices {
        vault_supply_exchange_price,
        vault_borrow_exchange_price,
    })
}

pub fn decode_vault_tokens(data: &[u8]) -> Result<JupiterVaultTokens> {
    let mut r = ByteReader::after_disc(data, VAULT_CONFIG_DISC)?;
    r.u16()?; // vault_id
    r.i16()?; // supply_rate_magnifier
    r.i16()?; // borrow_rate_magnifier
    r.u16()?; // collateral_factor
    r.u16()?; // liquidation_threshold
    r.u16()?; // liquidation_max_limit
    r.u16()?; // withdraw_gap
    r.u16()?; // liquidation_penalty
    r.u8()?; // borrow_fee
    r.u8()?; // vault_type
    r.pubkey()?; // oracle
    r.pubkey()?; // rebalancer
    r.pubkey()?; // liquidity_program
    r.pubkey()?; // oracle_program
    let supply_token = r.pubkey()?;
    let borrow_token = r.pubkey()?;
    Ok(JupiterVaultTokens {
        supply_token,
        borrow_token,
    })
}

struct ByteReader<'a> {
    data: &'a [u8],
    i: usize,
}

impl<'a> ByteReader<'a> {
    fn after_disc(data: &'a [u8], disc: [u8; 8]) -> Result<Self> {
        require!(data.len() >= 8, LendMirrorError::InvalidJupiterAccount);
        require!(data[0..8] == disc, LendMirrorError::InvalidJupiterAccount);
        Ok(Self { data, i: 8 })
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        require!(
            self.i + n <= self.data.len(),
            LendMirrorError::InvalidJupiterAccount
        );
        let s = &self.data[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.take(16)?.try_into().unwrap()))
    }

    fn pubkey(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::new_from_array(self.take(32)?.try_into().unwrap()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_position_roundtrip_bytes() {
        let mut data = POSITION_DISC.to_vec();
        data.extend_from_slice(&7u16.to_le_bytes());
        data.extend_from_slice(&42u32.to_le_bytes());
        data.extend_from_slice(&[3u8; 32]);
        data.push(0);
        data.extend_from_slice(&(-100i32).to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&1_000u64.to_le_bytes());
        data.extend_from_slice(&5u64.to_le_bytes());

        let p = decode_position(&data).unwrap();
        assert_eq!(p.vault_id, 7);
        assert_eq!(p.nft_id, 42);
        assert_eq!(p.supply_amount, 1_000);
        assert_eq!(p.dust_debt_amount, 5);
        assert_eq!(p.tick, -100);
    }
}
