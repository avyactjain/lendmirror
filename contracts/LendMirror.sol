// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { PositionSnapshotMsgCodec } from "./libs/PositionSnapshotMsgCodec.sol";

error LzPayloadTooShort();
error InvalidPositionPayload();

/// Ethereum receiver for LendMirror. Solana `send` is the sender.
/// `_lzReceive` stores the last Jupiter position snapshot from the Solana payload.
contract LendMirror is OApp, OAppOptionsType3 {
    constructor(address _endpoint, address _delegate) OApp(_endpoint, _delegate) Ownable(_delegate) {}

    /// Last Jupiter position snapshot received from Solana.
    PositionSnapshotMsgCodec.Snapshot internal lastPosition_;

    /// EVM wall-clock when `lastPosition_` was last written (`block.timestamp`).
    /// Clients use this for freshness; distinct from `snapshot.snapshotTime` (Solana clock).
    uint64 public lastUpdatedTs;

    /// EVM block number when `lastPosition_` was last written.
    uint64 public lastUpdatedBlock;

    function lastPosition() external view returns (PositionSnapshotMsgCodec.Snapshot memory) {
        return lastPosition_;
    }

    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata payload,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        if (payload.length < 32) revert LzPayloadTooShort();
        uint256 declared = uint256(bytes32(payload[0:32]));
        if (declared != PositionSnapshotMsgCodec.BODY_LEN) revert InvalidPositionPayload();
        lastPosition_ = PositionSnapshotMsgCodec.decode(payload);
        lastUpdatedTs = uint64(block.timestamp);
        lastUpdatedBlock = uint64(block.number);
    }
}
