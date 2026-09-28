// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Any2EVMMessage, EVMTokenAmount } from "../../contracts/LendMirror.sol";
import { LendMirrorTreasury } from "../../contracts/LendMirrorTreasury.sol";

contract TestUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Pretends to be Circle's MessageTransmitterV2: mints USDC to the treasury on `receiveMessage`.
contract TransmitterStub {
    TestUSDC internal usdc;
    address internal to;
    bool internal shouldFail;

    constructor(TestUSDC _usdc, address _to) {
        usdc = _usdc;
        to = _to;
    }

    function setFail(bool v) external {
        shouldFail = v;
    }

    function receiveMessage(bytes calldata, bytes calldata) external returns (bool) {
        if (shouldFail) return false;
        usdc.mint(to, 1_000_000);
        return true;
    }
}

contract LendMirrorTreasuryTest is Test {
    LendMirrorTreasury internal treasury;
    TestUSDC internal usdc;
    address internal constant OWNER = address(0xD);
    address internal constant STRATEGY = address(0x5);
    bytes32 internal constant SOLANA_SENDER = bytes32(uint256(0xA11CE));
    uint64 internal constant SOLANA_SELECTOR = 16_423_721_717_087_811_551;

    function setUp() public {
        LendMirrorTreasury impl = new LendMirrorTreasury();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(LendMirrorTreasury.initialize, (OWNER)));
        treasury = LendMirrorTreasury(address(proxy));
        usdc = new TestUSDC();
    }

    function testForwardGoesOnlyToTheStrategy() public {
        usdc.mint(address(treasury), 5_000_000);
        vm.expectRevert(abi.encodeWithSelector(LendMirrorTreasury.NoStrategy.selector, address(usdc)));
        treasury.forward(address(usdc));

        vm.prank(OWNER);
        treasury.setStrategy(address(usdc), STRATEGY);
        // Anyone may press the button; the destination is fixed.
        vm.prank(address(0xBEEF));
        treasury.forward(address(usdc));
        assertEq(usdc.balanceOf(STRATEGY), 5_000_000);
        assertEq(usdc.balanceOf(address(treasury)), 0);

        vm.expectRevert(abi.encodeWithSelector(LendMirrorTreasury.NothingToForward.selector, address(usdc)));
        treasury.forward(address(usdc));
    }

    function testStrangerCannotSetStrategy() public {
        vm.expectRevert();
        treasury.setStrategy(address(usdc), address(0xBAD));
    }

    function testCcipReceiveChecksRouterLaneAndSender() public {
        vm.prank(OWNER);
        treasury.setCcipRoute(address(this), SOLANA_SELECTOR, SOLANA_SENDER, true);

        EVMTokenAmount[] memory amounts = new EVMTokenAmount[](1);
        amounts[0] = EVMTokenAmount({ token: address(usdc), amount: 1_000_000 });
        Any2EVMMessage memory msg_ = Any2EVMMessage({
            messageId: keccak256("id"),
            sourceChainSelector: SOLANA_SELECTOR,
            sender: abi.encodePacked(SOLANA_SENDER),
            data: "",
            destTokenAmounts: amounts
        });

        vm.expectEmit(true, true, false, true, address(treasury));
        emit LendMirrorTreasury.TokensReceived(keccak256("id"), address(usdc), 1_000_000);
        treasury.ccipReceive(msg_);

        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(LendMirrorTreasury.OnlyCcipRouter.selector, address(0xBEEF)));
        treasury.ccipReceive(msg_);

        msg_.sourceChainSelector = 1;
        vm.expectRevert(abi.encodeWithSelector(LendMirrorTreasury.UnexpectedCcipSource.selector, uint64(1)));
        treasury.ccipReceive(msg_);

        msg_.sourceChainSelector = SOLANA_SELECTOR;
        msg_.sender = abi.encodePacked(bytes32(uint256(0xBAD)));
        vm.expectRevert(LendMirrorTreasury.UnexpectedCcipSender.selector);
        treasury.ccipReceive(msg_);
    }

    function testClaimCctpMintsToTreasury() public {
        TransmitterStub transmitter = new TransmitterStub(usdc, address(treasury));
        vm.prank(OWNER);
        treasury.setCctpMessageTransmitter(address(transmitter));

        treasury.claimCctp("message", "attestation");
        assertEq(usdc.balanceOf(address(treasury)), 1_000_000);

        transmitter.setFail(true);
        vm.expectRevert(LendMirrorTreasury.CctpClaimFailed.selector);
        treasury.claimCctp("message", "attestation");
    }

    function testOwnerUpgradesStrangerCannot() public {
        LendMirrorTreasury next = new LendMirrorTreasury();
        vm.expectRevert();
        treasury.upgradeToAndCall(address(next), "");
        vm.prank(OWNER);
        treasury.upgradeToAndCall(address(next), "");
    }
}
