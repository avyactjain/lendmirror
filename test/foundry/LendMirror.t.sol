// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

import { Any2EVMMessage, EVMTokenAmount, IAny2EVMMessageReceiver, LendMirror } from "../../contracts/LendMirror.sol";
import { PositionSnapshotMsgCodec } from "../../contracts/libs/PositionSnapshotMsgCodec.sol";

/// Accepts `initialize`'s `setDelegate` call. An empty address reverts.
contract EndpointStub {
    function setDelegate(address) external {}
}

/// Exposes `_lzReceive` for unit tests (skips Endpoint/peer checks).
contract LendMirrorHarness is LendMirror {
    constructor(address _endpoint) LendMirror(_endpoint) {}

    function exposeLzReceive(Origin calldata origin, bytes32 guid, bytes calldata payload) external {
        _lzReceive(origin, guid, payload, address(0), payload[:0]);
    }
}

contract LendMirrorReceiveTest is Test {
    LendMirrorHarness internal app;
    address internal constant DELEGATE = address(0xD);

    function setUp() public {
        EndpointStub endpoint = new EndpointStub();
        LendMirrorHarness impl = new LendMirrorHarness(address(endpoint));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(LendMirror.initialize, (DELEGATE)));
        app = LendMirrorHarness(address(proxy));
    }

    function _payload() internal pure returns (bytes memory) {
        bytes32 position = hex"0101010101010101010101010101010101010101010101010101010101010101";
        uint16 vaultId = 1;
        uint32 nftId = 29;
        bytes32 positionMint = hex"0202020202020202020202020202020202020202020202020202020202020202";
        bytes32 supplyToken = hex"0303030303030303030303030303030303030303030303030303030303030303";
        bytes32 borrowToken = hex"0404040404040404040404040404040404040404040404040404040404040404";
        return abi.encodePacked(
            bytes32(uint256(225)),
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
            uint64(11_000_000),
            uint64(13_000_000),
            int32(-90),
            false,
            true,
            false,
            uint32(4),
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

    function testPricedPositionMatchesJupiterScaling() public {
        app.exposeLzReceive(
            Origin({ srcEid: 40168, sender: bytes32(uint256(1)), nonce: 1 }),
            bytes32(0),
            _payload()
        );
        PositionSnapshotMsgCodec.Priced memory p = app.pricedPosition();
        assertEq(p.supply, 10_000);
        assertEq(p.borrow, 12_099);
        assertEq(p.dustBorrow, 15);
    }

    function testOwnerCanUpgrade() public {
        LendMirrorHarness next = new LendMirrorHarness(address(new EndpointStub()));
        vm.prank(DELEGATE);
        app.upgradeToAndCall(address(next), "");
    }

    function testStrangerCannotUpgrade() public {
        LendMirrorHarness next = new LendMirrorHarness(address(new EndpointStub()));
        vm.expectRevert();
        app.upgradeToAndCall(address(next), "");
    }

    function testMatchedWhenBothRoutersDeliverTheSameBody() public {
        bytes memory frame = _payload();
        bytes memory body = _body(frame);
        bytes32 position = hex"0101010101010101010101010101010101010101010101010101010101010101";

        app.exposeLzReceive(Origin({ srcEid: 40168, sender: bytes32(uint256(1)), nonce: 1 }), bytes32(0), frame);
        assertFalse(app.matched(position));

        _allowCcip();
        app.ccipReceive(_ccip(body));

        assertTrue(app.matched(position));
        assertEq(app.fromLayerZero(position).bodyHash, keccak256(body));
        assertEq(app.fromChainlink(position).bodyHash, keccak256(body));
        assertEq(app.fromLayerZero(position).snapshot.vaultId, 1);
        assertEq(app.fromChainlink(position).snapshot.nftId, 29);
    }

    function testNotMatchedWhenBodiesDiffer() public {
        bytes memory frame = _payload();
        bytes memory body = _body(frame);
        body[142] = hex"ff";
        bytes32 position = hex"0101010101010101010101010101010101010101010101010101010101010101";

        app.exposeLzReceive(Origin({ srcEid: 40168, sender: bytes32(uint256(1)), nonce: 1 }), bytes32(0), frame);
        _allowCcip();
        app.ccipReceive(_ccip(body));

        assertFalse(app.matched(position));
        assertTrue(app.fromLayerZero(position).received);
        assertTrue(app.fromChainlink(position).received);
    }

    function testChainlinkCanSeeTheReceiver() public view {
        assertTrue(app.supportsInterface(type(IAny2EVMMessageReceiver).interfaceId));
        assertTrue(app.supportsInterface(type(IERC165).interfaceId));
        assertFalse(app.supportsInterface(0xffffffff));
    }

    function testCcipRejectsStrangerAndWrongSource() public {
        bytes memory body = _body(_payload());
        _allowCcip();

        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(LendMirror.OnlyCcipRouter.selector, address(0xBEEF)));
        app.ccipReceive(_ccip(body));

        Any2EVMMessage memory wrongChain = _ccip(body);
        wrongChain.sourceChainSelector = 1;
        vm.expectRevert(abi.encodeWithSelector(LendMirror.UnexpectedCcipSource.selector, uint64(1)));
        app.ccipReceive(wrongChain);
    }

    function _body(bytes memory frame) internal pure returns (bytes memory body) {
        body = new bytes(225);
        for (uint256 i = 0; i < 225; i++) {
            body[i] = frame[32 + i];
        }
    }

    function _allowCcip() internal {
        vm.prank(DELEGATE);
        app.setCcipRoute(address(this), 16_423_721_717_087_811_551, abi.encodePacked(bytes32(uint256(0xA11CE))));
    }

    function _ccip(bytes memory body) internal pure returns (Any2EVMMessage memory) {
        return Any2EVMMessage({
            messageId: keccak256("ccip"),
            sourceChainSelector: 16_423_721_717_087_811_551,
            sender: abi.encodePacked(bytes32(uint256(0xA11CE))),
            data: body,
            destTokenAmounts: new EVMTokenAmount[](0)
        });
    }
}
