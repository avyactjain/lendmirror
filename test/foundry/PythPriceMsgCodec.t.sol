// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { PythPriceMsgCodec, PythMsgTooShort, PythInvalidBodyLength } from "../../contracts/libs/PythPriceMsgCodec.sol";

contract PythCodecHarness {
    function decode(bytes calldata m) external pure returns (PythPriceMsgCodec.Snapshot memory) {
        return PythPriceMsgCodec.decode(m);
    }
}

contract PythPriceMsgCodecTest is Test {
    PythCodecHarness internal harness;

    function setUp() public {
        harness = new PythCodecHarness();
    }

    function testDecodeKnownVector() public view {
        bytes32 pythAccount = hex"0101010101010101010101010101010101010101010101010101010101010101";
        bytes32 feedId = hex"0707070707070707070707070707070707070707070707070707070707070707";
        int64 price = -123;
        uint64 conf = 4;
        int32 exponent = -8;
        int64 publishTime = 1_700_000_000;

        bytes memory payload = abi.encodePacked(
            bytes32(uint256(92)),
            pythAccount,
            feedId,
            price,
            conf,
            exponent,
            publishTime
        );

        PythPriceMsgCodec.Snapshot memory s = harness.decode(payload);
        assertEq(s.pythAccount, pythAccount);
        assertEq(s.feedId, feedId);
        assertEq(s.price, price);
        assertEq(s.conf, conf);
        assertEq(s.exponent, exponent);
        assertEq(s.publishTime, publishTime);
    }

    function testRevertShortHeader() public {
        bytes memory payload = hex"00";
        vm.expectRevert(PythMsgTooShort.selector);
        harness.decode(payload);
    }

    function testRevertWrongBodyLength() public {
        bytes memory payload = abi.encodePacked(bytes32(uint256(1)), bytes1(0x00));
        vm.expectRevert(PythInvalidBodyLength.selector);
        harness.decode(payload);
    }
}
