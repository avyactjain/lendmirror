// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

import { LendMirror } from "../../contracts/LendMirror.sol";
import { PositionSnapshotMsgCodec } from "../../contracts/libs/PositionSnapshotMsgCodec.sol";

/// Exposes `_lzReceive` for unit tests (skips Endpoint/peer checks).
contract LendMirrorHarness is LendMirror {
    constructor(address _endpoint, address _delegate) LendMirror(_endpoint, _delegate) {}

    function exposeLzReceive(Origin calldata origin, bytes32 guid, bytes calldata payload) external {
        _lzReceive(origin, guid, payload, address(0), "");
    }
}

contract LendMirrorReceiveTest is Test {
    LendMirrorHarness internal app;
    address internal constant ENDPOINT = address(0xE);
    address internal constant DELEGATE = address(0xD);

    function setUp() public {
        app = new LendMirrorHarness(ENDPOINT, DELEGATE);
    }

    function _payload() internal pure returns (bytes memory) {
        bytes32 position = hex"0101010101010101010101010101010101010101010101010101010101010101";
        uint16 vaultId = 1;
        uint32 nftId = 29;
        bytes32 positionMint = hex"0202020202020202020202020202020202020202020202020202020202020202";
        bytes32 supplyToken = hex"0303030303030303030303030303030303030303030303030303030303030303";
        bytes32 borrowToken = hex"0404040404040404040404040404040404040404040404040404040404040404";
        return abi.encodePacked(
            bytes32(uint256(200)),
            position,
            vaultId,
            nftId,
            positionMint,
            supplyToken,
            borrowToken,
            uint64(10_000_000),
            uint64(12_114_964),
            uint64(15_329),
            uint64(12_099_635),
            int32(-100),
            uint32(1),
            false,
            true,
            uint64(1_000_000_000),
            uint64(1_000_000_001),
            int64(1_700_000_000)
        );
    }

    function testPositionReceivedEvent() public {
        bytes memory payload = _payload();
        Origin memory origin = Origin({ srcEid: 40168, sender: bytes32(uint256(1)), nonce: 1 });
        bytes32 guid = keccak256("guid");

        vm.warp(1_800_000_000);
        vm.roll(12_345);

        vm.expectEmit(true, true, false, true, address(app));
        emit LendMirror.PositionReceived(40168, guid, 1, 29, 1_700_000_000, 1_800_000_000, 12_345);

        app.exposeLzReceive(origin, guid, payload);

        PositionSnapshotMsgCodec.Snapshot memory s = app.lastPosition();
        assertEq(s.vaultId, 1);
        assertEq(s.nftId, 29);
        assertEq(app.lastUpdatedTs(), 1_800_000_000);
        assertEq(app.lastUpdatedBlock(), 12_345);
    }
}
