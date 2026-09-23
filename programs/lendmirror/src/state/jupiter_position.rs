use crate::errors::LendMirrorError;
use crate::msg_codec::{unwrap_lz_payload, wrap_lz_payload, LzMessage, MsgCodecError};
use anchor_lang::prelude::*;

/// Known Jupiter Lend Vaults ids. Pass one of these into `init_store`.
#[allow(dead_code)]
pub const JUPITER_VAULTS_MAINNET: Pubkey = pubkey!("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");
#[allow(dead_code)]
pub const JUPITER_VAULTS_DEVNET: Pubkey = pubkey!("Ho32sUQ4NzuAQgkPkHuNDG3G18rgHmYtXFA8EBmqQrAu");

const POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const TICK_DISC: [u8; 8] = [176, 94, 67, 247, 133, 173, 7, 115];
const VAULT_STATE_DISC: [u8; 8] = [228, 196, 82, 165, 98, 210, 235, 152];
const VAULT_CONFIG_DISC: [u8; 8] = [99, 86, 43, 216, 184, 102, 119, 77];
const BRANCH_DISC: [u8; 8] = [14, 63, 100, 50, 25, 8, 29, 5];
const TICK_ID_LIQUIDATION_DISC: [u8; 8] = [41, 28, 190, 197, 68, 213, 31, 181];

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

/// Packed Jupiter Branch body. One branch per liquidation event.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct JupiterBranch {
    pub vault_id: u16,
    pub branch_id: u32,
    pub status: u8,
    pub minima_tick: i32,
    pub minima_tick_partials: u32,
    pub debt_liquidity: u64,
    pub debt_factor: u64,
    pub connected_branch_id: u32,
    pub connected_minima_tick: i32,
}

/// One position id's liquidation record, flushed out of the Tick account.
#[derive(Clone, Copy, Debug, Default)]
pub struct TickIdLiquidationSlot {
    pub is_fully_liquidated: u8,
    pub liquidation_branch_id: u32,
    pub debt_factor: u64,
}

/// Packed Jupiter TickIdLiquidation body. Holds three position ids.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct JupiterTickIdLiquidation {
    pub vault_id: u16,
    pub tick: i32,
    pub tick_map: u32,
    pub slots: [TickIdLiquidationSlot; 3],
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

/// Packed LZ body (no 8-byte Anchor discriminator). Integers are big-endian.
/// position 32 | vault_id u16 | nft_id u32 | mint 32 | supply 32 | borrow 32
/// | col u64 | debt u64 | dust u64 | net u64 | tick i32 | tick_id u32
/// | stored_col u64 | stored_debt u64 | stored_tick i32
/// | supply_only u8 | liquidated u8 | fully_liquidated u8 | branch_id u32
/// | supply_px u64 | borrow_px u64 | time i64
pub const POSITION_SNAPSHOT_BODY_LEN: usize = 225;

/// Snapshot we store. Not a Jupiter account.
///
/// `col_raw`, `debt_raw`, `net_debt` and `tick` are **live**: they already
/// account for any liquidation that hit this position's tick. The `stored_*`
/// fields are what the Jupiter Position account still says, so a consumer can
/// see how far the two have drifted apart.
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
    pub stored_col_raw: u64,
    pub stored_debt_raw: u64,
    pub stored_tick: i32,
    pub is_supply_only: bool,
    pub is_liquidated: bool,
    pub is_fully_liquidated: bool,
    /// Branch the liquidation walk ended on. 0 when never liquidated.
    pub branch_id: u32,
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

impl PositionSnapshot {
    /// The 225 bytes both routers carry. LayerZero frames this with a length header.
    /// CCIP sends these bytes as the message data. CCIP's data limit is 256 bytes.
    pub fn encode_body(&self) -> Vec<u8> {
        let mut body = Vec::with_capacity(POSITION_SNAPSHOT_BODY_LEN);
        body.extend_from_slice(self.position.as_ref());
        body.extend_from_slice(&self.vault_id.to_be_bytes());
        body.extend_from_slice(&self.nft_id.to_be_bytes());
        body.extend_from_slice(self.position_mint.as_ref());
        body.extend_from_slice(self.supply_token.as_ref());
        body.extend_from_slice(self.borrow_token.as_ref());
        body.extend_from_slice(&self.col_raw.to_be_bytes());
        body.extend_from_slice(&self.debt_raw.to_be_bytes());
        body.extend_from_slice(&self.dust_debt.to_be_bytes());
        body.extend_from_slice(&self.net_debt.to_be_bytes());
        body.extend_from_slice(&self.tick.to_be_bytes());
        body.extend_from_slice(&self.tick_id.to_be_bytes());
        body.extend_from_slice(&self.stored_col_raw.to_be_bytes());
        body.extend_from_slice(&self.stored_debt_raw.to_be_bytes());
        body.extend_from_slice(&self.stored_tick.to_be_bytes());
        body.push(self.is_supply_only as u8);
        body.push(self.is_liquidated as u8);
        body.push(self.is_fully_liquidated as u8);
        body.extend_from_slice(&self.branch_id.to_be_bytes());
        body.extend_from_slice(&self.vault_supply_exchange_price.to_be_bytes());
        body.extend_from_slice(&self.vault_borrow_exchange_price.to_be_bytes());
        body.extend_from_slice(&self.snapshot_time.to_be_bytes());
        body
    }
}

impl LzMessage for PositionSnapshot {
    fn encode(&self) -> Vec<u8> {
        wrap_lz_payload(&self.encode_body())
    }

    fn decode(buf: &[u8]) -> std::result::Result<Self, MsgCodecError> {
        let body = unwrap_lz_payload(buf)?;
        if body.len() != POSITION_SNAPSHOT_BODY_LEN {
            return Err(MsgCodecError::BodyTooShort);
        }
        Ok(Self {
            position: Pubkey::try_from(&body[0..32]).map_err(|_| MsgCodecError::InvalidLength)?,
            vault_id: u16::from_be_bytes(body[32..34].try_into().unwrap()),
            nft_id: u32::from_be_bytes(body[34..38].try_into().unwrap()),
            position_mint: Pubkey::try_from(&body[38..70])
                .map_err(|_| MsgCodecError::InvalidLength)?,
            supply_token: Pubkey::try_from(&body[70..102])
                .map_err(|_| MsgCodecError::InvalidLength)?,
            borrow_token: Pubkey::try_from(&body[102..134])
                .map_err(|_| MsgCodecError::InvalidLength)?,
            col_raw: u64::from_be_bytes(body[134..142].try_into().unwrap()),
            debt_raw: u64::from_be_bytes(body[142..150].try_into().unwrap()),
            dust_debt: u64::from_be_bytes(body[150..158].try_into().unwrap()),
            net_debt: u64::from_be_bytes(body[158..166].try_into().unwrap()),
            tick: i32::from_be_bytes(body[166..170].try_into().unwrap()),
            tick_id: u32::from_be_bytes(body[170..174].try_into().unwrap()),
            stored_col_raw: u64::from_be_bytes(body[174..182].try_into().unwrap()),
            stored_debt_raw: u64::from_be_bytes(body[182..190].try_into().unwrap()),
            stored_tick: i32::from_be_bytes(body[190..194].try_into().unwrap()),
            is_supply_only: body[194] != 0,
            is_liquidated: body[195] != 0,
            is_fully_liquidated: body[196] != 0,
            branch_id: u32::from_be_bytes(body[197..201].try_into().unwrap()),
            vault_supply_exchange_price: u64::from_be_bytes(body[201..209].try_into().unwrap()),
            vault_borrow_exchange_price: u64::from_be_bytes(body[209..217].try_into().unwrap()),
            snapshot_time: i64::from_be_bytes(body[217..225].try_into().unwrap()),
        })
    }
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

pub fn decode_branch(data: &[u8]) -> Result<JupiterBranch> {
    let mut r = ByteReader::after_disc(data, BRANCH_DISC)?;
    Ok(JupiterBranch {
        vault_id: r.u16()?,
        branch_id: r.u32()?,
        status: r.u8()?,
        minima_tick: r.i32()?,
        minima_tick_partials: r.u32()?,
        debt_liquidity: r.u64()?,
        debt_factor: r.u64()?,
        connected_branch_id: r.u32()?,
        connected_minima_tick: r.i32()?,
    })
}

pub fn decode_tick_id_liquidation(data: &[u8]) -> Result<JupiterTickIdLiquidation> {
    let mut r = ByteReader::after_disc(data, TICK_ID_LIQUIDATION_DISC)?;
    let vault_id = r.u16()?;
    let tick = r.i32()?;
    let tick_map = r.u32()?;
    let mut slots = [TickIdLiquidationSlot::default(); 3];
    for slot in slots.iter_mut() {
        slot.is_fully_liquidated = r.u8()?;
        slot.liquidation_branch_id = r.u32()?;
        slot.debt_factor = r.u64()?;
    }
    Ok(JupiterTickIdLiquidation { vault_id, tick, tick_map, slots })
}

/// Jupiter Branch PDA: `["branch", vault_id le, branch_id le]`.
pub fn branch_address(vaults_program: &Pubkey, vault_id: u16, branch_id: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"branch", &vault_id.to_le_bytes(), &branch_id.to_le_bytes()],
        vaults_program,
    )
    .0
}

/// Jupiter TickIdLiquidation PDA. One account holds three position ids, so the
/// last seed is the group number, not the id itself.
pub fn tick_id_liquidation_address(
    vaults_program: &Pubkey,
    vault_id: u16,
    tick: i32,
    tick_id: u32,
) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"tick_id_liquidation",
            &vault_id.to_le_bytes(),
            &crate::tick_math::tick_pda_seed(tick),
            &((tick_id + 2) / 3).to_le_bytes(),
        ],
        vaults_program,
    )
    .0
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
    Ok(JupiterVaultStatePrices { vault_supply_exchange_price, vault_borrow_exchange_price })
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
    Ok(JupiterVaultTokens { supply_token, borrow_token })
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
        require!(self.i + n <= self.data.len(), LendMirrorError::InvalidJupiterAccount);
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
    use crate::msg_codec::LzMessage;

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

    #[test]
    fn position_snapshot_lz_roundtrip() {
        let original = PositionSnapshot {
            position: Pubkey::new_from_array([1u8; 32]),
            vault_id: 1,
            nft_id: 29,
            position_mint: Pubkey::new_from_array([2u8; 32]),
            supply_token: Pubkey::new_from_array([3u8; 32]),
            borrow_token: Pubkey::new_from_array([4u8; 32]),
            col_raw: 10_000_000,
            debt_raw: 12_114_964,
            dust_debt: 15_329,
            net_debt: 12_099_635,
            tick: -100,
            tick_id: 1,
            stored_col_raw: 11_000_000,
            stored_debt_raw: 13_000_000,
            stored_tick: -90,
            is_supply_only: false,
            is_liquidated: true,
            is_fully_liquidated: false,
            branch_id: 4,
            vault_supply_exchange_price: 1_000_000_000,
            vault_borrow_exchange_price: 1_000_000_001,
            snapshot_time: 1_700_000_000,
        };
        let encoded = original.encode();
        let decoded = PositionSnapshot::decode(&encoded).unwrap();
        assert_eq!(original.position, decoded.position);
        assert_eq!(original.vault_id, decoded.vault_id);
        assert_eq!(original.nft_id, decoded.nft_id);
        assert_eq!(original.position_mint, decoded.position_mint);
        assert_eq!(original.supply_token, decoded.supply_token);
        assert_eq!(original.borrow_token, decoded.borrow_token);
        assert_eq!(original.col_raw, decoded.col_raw);
        assert_eq!(original.debt_raw, decoded.debt_raw);
        assert_eq!(original.dust_debt, decoded.dust_debt);
        assert_eq!(original.net_debt, decoded.net_debt);
        assert_eq!(original.tick, decoded.tick);
        assert_eq!(original.tick_id, decoded.tick_id);
        assert_eq!(original.stored_col_raw, decoded.stored_col_raw);
        assert_eq!(original.stored_debt_raw, decoded.stored_debt_raw);
        assert_eq!(original.stored_tick, decoded.stored_tick);
        assert_eq!(original.is_supply_only, decoded.is_supply_only);
        assert_eq!(original.is_liquidated, decoded.is_liquidated);
        assert_eq!(original.is_fully_liquidated, decoded.is_fully_liquidated);
        assert_eq!(original.branch_id, decoded.branch_id);
        assert_eq!(original.vault_supply_exchange_price, decoded.vault_supply_exchange_price);
        assert_eq!(original.vault_borrow_exchange_price, decoded.vault_borrow_exchange_price);
        assert_eq!(original.snapshot_time, decoded.snapshot_time);
        assert_eq!(POSITION_SNAPSHOT_BODY_LEN, PositionSnapshot::INIT_SPACE);
        assert_eq!(encoded.len(), 32 + POSITION_SNAPSHOT_BODY_LEN);
        assert_eq!(&encoded[28..32], &(POSITION_SNAPSHOT_BODY_LEN as u32).to_be_bytes());
        assert_eq!(&encoded[32..64], original.position.as_ref());
        assert_eq!(&encoded[64..66], &original.vault_id.to_be_bytes());
        assert_eq!(&encoded[198..202], &original.tick.to_be_bytes());
        // Solidity reads these same offsets; keep them pinned.
        assert_eq!(&encoded[206..214], &original.stored_col_raw.to_be_bytes());
        assert_eq!(encoded[226], 0); // is_supply_only
        assert_eq!(encoded[227], 1); // is_liquidated
        assert_eq!(encoded[228], 0); // is_fully_liquidated
        assert_eq!(&encoded[229..233], &original.branch_id.to_be_bytes());
        assert_eq!(original.encode_body(), encoded[32..]);
    }

    #[test]
    fn decode_branch_bytes() {
        let mut data = BRANCH_DISC.to_vec();
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&3u32.to_le_bytes());
        data.push(2); // status = merged
        data.extend_from_slice(&(-500i32).to_le_bytes());
        data.extend_from_slice(&123u32.to_le_bytes());
        data.extend_from_slice(&7_000u64.to_le_bytes());
        data.extend_from_slice(&900u64.to_le_bytes());
        data.extend_from_slice(&5u32.to_le_bytes());
        data.extend_from_slice(&(-400i32).to_le_bytes());

        let b = decode_branch(&data).unwrap();
        assert_eq!(b.branch_id, 3);
        assert_eq!(b.status, 2);
        assert_eq!(b.minima_tick, -500);
        assert_eq!(b.minima_tick_partials, 123);
        assert_eq!(b.debt_factor, 900);
        assert_eq!(b.connected_branch_id, 5);
    }

    #[test]
    fn tick_id_liquidation_pda_groups_three_ids() {
        let program = Pubkey::new_unique();
        let a = tick_id_liquidation_address(&program, 1, -100, 1);
        let b = tick_id_liquidation_address(&program, 1, -100, 2);
        let c = tick_id_liquidation_address(&program, 1, -100, 3);
        let d = tick_id_liquidation_address(&program, 1, -100, 4);
        // (id + 2) / 3: 1 and 2 and 3 share group 1; 4 is group 2.
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, d);
    }
}
