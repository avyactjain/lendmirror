// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

error PositionMsgTooShort();
error PositionInvalidBodyLength();

/// Same layout as `impl LzMessage for PositionSnapshot` on Solana.
///
/// [32-byte length header][225-byte body]
/// Body, big-endian:
///   bytes32 position | uint16 vaultId | uint32 nftId
///   | bytes32 positionMint | bytes32 supplyToken | bytes32 borrowToken
///   | uint64 colRaw | uint64 debtRaw | uint64 dustDebt | uint64 netDebt
///   | int32 tick | uint32 tickId
///   | uint64 storedColRaw | uint64 storedDebtRaw | int32 storedTick
///   | bool isSupplyOnly | bool isLiquidated | bool isFullyLiquidated | uint32 branchId
///   | uint64 vaultSupplyExchangePrice | uint64 vaultBorrowExchangePrice
///   | int64 snapshotTime
///
/// `colRaw`, `debtRaw`, `netDebt`, and `tick` are live (after any liquidation
/// branch walk). `stored*` is what the Jupiter Position account still says.
library PositionSnapshotMsgCodec {
    uint8 public constant VANILLA_TYPE = 1;
    uint256 internal constant HEADER_LEN = 32;
    uint256 public constant BODY_LEN = 225;
    /// Jupiter divides by this after multiplying an amount by an exchange price.
    uint256 public constant EXCHANGE_PRICE_SCALE = 1e12;

    struct Snapshot {
        bytes32 position;
        uint16 vaultId;
        uint32 nftId;
        bytes32 positionMint;
        bytes32 supplyToken;
        bytes32 borrowToken;
        uint64 colRaw;
        uint64 debtRaw;
        uint64 dustDebt;
        uint64 netDebt;
        int32 tick;
        uint32 tickId;
        uint64 storedColRaw;
        uint64 storedDebtRaw;
        int32 storedTick;
        bool isSupplyOnly;
        bool isLiquidated;
        bool isFullyLiquidated;
        uint32 branchId;
        uint64 vaultSupplyExchangePrice;
        uint64 vaultBorrowExchangePrice;
        int64 snapshotTime;
    }

    /// Same numbers `getPositionByVaultIdV2` returns as `supply`, `borrow`, and `dustBorrow`.
    struct Priced {
        uint256 supply;
        uint256 borrow;
        uint256 dustBorrow;
    }

    function decode(bytes calldata _msg) internal pure returns (Snapshot memory s) {
        if (_msg.length < HEADER_LEN) revert PositionMsgTooShort();

        uint256 declared = uint256(bytes32(_msg[0:HEADER_LEN]));
        if (declared != BODY_LEN || _msg.length < HEADER_LEN + BODY_LEN) revert PositionInvalidBodyLength();

        bytes calldata body = _msg[HEADER_LEN:HEADER_LEN + BODY_LEN];
        _ids(body, s);
        _amounts(body, s);
        _meta(body, s);
    }

    function _ids(bytes calldata body, Snapshot memory s) private pure {
        s.position = bytes32(body[0:32]);
        s.vaultId = uint16(bytes2(body[32:34]));
        s.nftId = uint32(bytes4(body[34:38]));
        s.positionMint = bytes32(body[38:70]);
        s.supplyToken = bytes32(body[70:102]);
        s.borrowToken = bytes32(body[102:134]);
    }

    function _amounts(bytes calldata body, Snapshot memory s) private pure {
        s.colRaw = uint64(bytes8(body[134:142]));
        s.debtRaw = uint64(bytes8(body[142:150]));
        s.dustDebt = uint64(bytes8(body[150:158]));
        s.netDebt = uint64(bytes8(body[158:166]));
    }

    function _meta(bytes calldata body, Snapshot memory s) private pure {
        s.tick = int32(uint32(bytes4(body[166:170])));
        s.tickId = uint32(bytes4(body[170:174]));
        s.storedColRaw = uint64(bytes8(body[174:182]));
        s.storedDebtRaw = uint64(bytes8(body[182:190]));
        s.storedTick = int32(uint32(bytes4(body[190:194])));
        s.isSupplyOnly = uint8(body[194]) != 0;
        s.isLiquidated = uint8(body[195]) != 0;
        s.isFullyLiquidated = uint8(body[196]) != 0;
        s.branchId = uint32(bytes4(body[197:201]));
        s.vaultSupplyExchangePrice = uint64(bytes8(body[201:209]));
        s.vaultBorrowExchangePrice = uint64(bytes8(body[209:217]));
        s.snapshotTime = int64(uint64(bytes8(body[217:225])));
    }

    /// Live collateral times the supply price. Live debt, after dust, times the borrow price.
    /// When dust covers the debt, both borrow and dust are 0.
    function price(Snapshot memory s) internal pure returns (Priced memory p) {
        p.supply = _scale(s.colRaw, s.vaultSupplyExchangePrice);
        uint256 debt = s.debtRaw;
        uint256 dust = s.dustDebt;
        if (debt > dust) {
            debt -= dust;
        } else {
            debt = 0;
            dust = 0;
        }
        p.borrow = _scale(debt, s.vaultBorrowExchangePrice);
        p.dustBorrow = _scale(dust, s.vaultBorrowExchangePrice);
    }

    function _scale(uint256 amount, uint256 exchangePrice) private pure returns (uint256) {
        return amount * exchangePrice / EXCHANGE_PRICE_SCALE;
    }
}
