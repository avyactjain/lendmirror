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
        uint64 storedColRaw = 11_000_000;
        uint64 storedDebtRaw = 13_000_000;
        int32 storedTick = -90;
        bool isSupplyOnly = false;
        bool isLiquidated = true;
        bool isFullyLiquidated = false;
        uint32 branchId = 4;
        uint64 vaultSupplyExchangePrice = 1_000_000_000;
        uint64 vaultBorrowExchangePrice = 1_000_000_001;
        int64 snapshotTime = 1_700_000_000;

        bytes memory payload = abi.encodePacked(
            bytes32(uint256(225)),
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
            storedColRaw,
            storedDebtRaw,
            storedTick,
            isSupplyOnly,
            isLiquidated,
            isFullyLiquidated,
            branchId,
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
        assertEq(s.storedColRaw, storedColRaw);
        assertEq(s.storedDebtRaw, storedDebtRaw);
        assertEq(s.storedTick, storedTick);
        assertEq(s.isSupplyOnly, isSupplyOnly);
        assertEq(s.isLiquidated, isLiquidated);
        assertEq(s.isFullyLiquidated, isFullyLiquidated);
        assertEq(s.branchId, branchId);
        assertEq(s.vaultSupplyExchangePrice, vaultSupplyExchangePrice);
        assertEq(s.vaultBorrowExchangePrice, vaultBorrowExchangePrice);
        assertEq(s.snapshotTime, snapshotTime);
        assertEq(payload.length, 257);
    }

    function testPriceMatchesJupiterScaling() public pure {
        PositionSnapshotMsgCodec.Snapshot memory s;
        s.colRaw = 10_000_000;
        s.debtRaw = 12_114_964;
        s.dustDebt = 15_329;
        s.vaultSupplyExchangePrice = 1_000_000_000;
        s.vaultBorrowExchangePrice = 1_000_000_001;
        PositionSnapshotMsgCodec.Priced memory p = PositionSnapshotMsgCodec.price(s);
        assertEq(p.supply, 10_000);
        assertEq(p.borrow, 12_099);
        assertEq(p.dustBorrow, 15);
    }

    function testPriceZerosBorrowWhenDustCoversDebt() public pure {
        PositionSnapshotMsgCodec.Snapshot memory s;
        s.colRaw = 100;
        s.debtRaw = 5;
        s.dustDebt = 9;
        s.vaultSupplyExchangePrice = 2e12;
        s.vaultBorrowExchangePrice = 3e12;
        PositionSnapshotMsgCodec.Priced memory p = PositionSnapshotMsgCodec.price(s);
        assertEq(p.supply, 200);
        assertEq(p.borrow, 0);
        assertEq(p.dustBorrow, 0);
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
