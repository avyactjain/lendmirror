// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import {
    PositionSnapshotMsgCodec,
    PositionMsgTooShort,
    PositionInvalidBodyLength
} from "../../contracts/libs/PositionSnapshotMsgCodec.sol";

contract PositionCodecHarness {
    function decode(bytes calldata m) external pure returns (PositionSnapshotMsgCodec.Snapshot memory) {
        return PositionSnapshotMsgCodec.decode(m);
    }
}

contract PositionSnapshotMsgCodecTest is Test {
    PositionCodecHarness internal harness;

    function setUp() public {
        harness = new PositionCodecHarness();
    }

    function testDecodeKnownVector() public view {
        bytes32 position = hex"0101010101010101010101010101010101010101010101010101010101010101";
        uint16 vaultId = 1;
        uint32 nftId = 29;
        bytes32 positionMint = hex"0202020202020202020202020202020202020202020202020202020202020202";
        bytes32 supplyToken = hex"0303030303030303030303030303030303030303030303030303030303030303";
        bytes32 borrowToken = hex"0404040404040404040404040404040404040404040404040404040404040404";
        uint64 colRaw = 10_000_000;
        uint64 debtRaw = 12_114_964;
        uint64 dustDebt = 15_329;
        uint64 netDebt = 12_099_635;
        int32 tick = -100;
        uint32 tickId = 1;
        bool isSupplyOnly = false;
        bool isLiquidated = true;
        uint64 vaultSupplyExchangePrice = 1_000_000_000;
        uint64 vaultBorrowExchangePrice = 1_000_000_001;
        int64 snapshotTime = 1_700_000_000;

        bytes memory payload = abi.encodePacked(
            bytes32(uint256(200)),
            position,
            vaultId,
            nftId,
            positionMint,
            supplyToken,
            borrowToken,
            colRaw,
            debtRaw,
            dustDebt,
            netDebt,
            tick,
            tickId,
            isSupplyOnly,
            isLiquidated,
            vaultSupplyExchangePrice,
            vaultBorrowExchangePrice,
            snapshotTime
        );

        PositionSnapshotMsgCodec.Snapshot memory s = harness.decode(payload);
        assertEq(s.position, position);
        assertEq(s.vaultId, vaultId);
        assertEq(s.nftId, nftId);
        assertEq(s.positionMint, positionMint);
        assertEq(s.supplyToken, supplyToken);
        assertEq(s.borrowToken, borrowToken);
        assertEq(s.colRaw, colRaw);
        assertEq(s.debtRaw, debtRaw);
        assertEq(s.dustDebt, dustDebt);
        assertEq(s.netDebt, netDebt);
        assertEq(s.tick, tick);
        assertEq(s.tickId, tickId);
        assertEq(s.isSupplyOnly, isSupplyOnly);
        assertEq(s.isLiquidated, isLiquidated);
        assertEq(s.vaultSupplyExchangePrice, vaultSupplyExchangePrice);
        assertEq(s.vaultBorrowExchangePrice, vaultBorrowExchangePrice);
        assertEq(s.snapshotTime, snapshotTime);
        assertEq(payload.length, 232);
    }

    function testRevertShortHeader() public {
        bytes memory payload = hex"00";
        vm.expectRevert(PositionMsgTooShort.selector);
        harness.decode(payload);
    }

    function testRevertWrongBodyLength() public {
        bytes memory payload = abi.encodePacked(bytes32(uint256(1)), bytes1(0x00));
        vm.expectRevert(PositionInvalidBodyLength.selector);
        harness.decode(payload);
    }
}
