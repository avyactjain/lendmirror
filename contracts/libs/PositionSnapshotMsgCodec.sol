// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

error PositionMsgTooShort();
error PositionInvalidBodyLength();

/// Same layout as `impl LzMessage for PositionSnapshot` on Solana.
///
/// [32-byte length header][200-byte body]
/// Body, big-endian:
///   bytes32 position | uint16 vaultId | uint32 nftId
///   | bytes32 positionMint | bytes32 supplyToken | bytes32 borrowToken
///   | uint64 colRaw | uint64 debtRaw | uint64 dustDebt | uint64 netDebt
///   | int32 tick | uint32 tickId | bool isSupplyOnly | bool isLiquidated
///   | uint64 vaultSupplyExchangePrice | uint64 vaultBorrowExchangePrice
///   | int64 snapshotTime
library PositionSnapshotMsgCodec {
    uint8 public constant VANILLA_TYPE = 1;
    uint256 internal constant HEADER_LEN = 32;
    uint256 public constant BODY_LEN = 200;

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
        bool isSupplyOnly;
        bool isLiquidated;
        uint64 vaultSupplyExchangePrice;
        uint64 vaultBorrowExchangePrice;
        int64 snapshotTime;
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
        s.isSupplyOnly = uint8(body[174]) != 0;
        s.isLiquidated = uint8(body[175]) != 0;
        s.vaultSupplyExchangePrice = uint64(bytes8(body[176:184]));
        s.vaultBorrowExchangePrice = uint64(bytes8(body[184:192]));
        s.snapshotTime = int64(uint64(bytes8(body[192:200])));
    }
}
