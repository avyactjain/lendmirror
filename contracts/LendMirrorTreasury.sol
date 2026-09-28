// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Any2EVMMessage, IAny2EVMMessageReceiver } from "./LendMirror.sol";

/// Circle's MessageTransmitterV2: `receiveMessage(message, attestation)` mints the USDC.
interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

/// The hardcoded EVM destination for every token bridged out of the Solana program.
///
/// Tokens arrive here from Circle CCTP (minted straight to this address; `claimCctp` triggers
/// the mint when the Solana route names this contract as `destinationCaller`) and from
/// Chainlink CCIP (`ccipReceive` with `destTokenAmounts`).
///
/// Tokens leave only through `forward`, and only to the strategy the owner set for that token.
/// There is no function that sends tokens to `msg.sender` or to a caller-supplied address.
/// Anyone may call `forward`, so an operator key can move funds without being able to
/// redirect them.
///
/// UUPS proxy, owner upgrades. Same pattern as `LendMirror`.
contract LendMirrorTreasury is Initializable, OwnableUpgradeable, UUPSUpgradeable, IAny2EVMMessageReceiver {
    using SafeERC20 for IERC20;

    event StrategySet(address indexed token, address indexed strategy);
    event Forwarded(address indexed token, address indexed strategy, uint256 amount);
    event TokensReceived(bytes32 indexed messageId, address indexed token, uint256 amount);
    event CctpClaimed(bytes32 indexed messageHash);
    event CcipSenderSet(bytes32 indexed sender, bool allowed);

    error ZeroAddress();
    error NoStrategy(address token);
    error NothingToForward(address token);
    error OnlyCcipRouter(address caller);
    error UnexpectedCcipSource(uint64 selector);
    error UnexpectedCcipSender();
    error CctpClaimFailed();

    /// Per token: the only address `forward` may send it to.
    mapping(address token => address strategy) public strategy;

    /// Chainlink router allowed to call `ccipReceive`, and the Solana selector + senders it must carry.
    address public ccipRouter;
    uint64 public ccipSourceChainSelector;
    /// Solana bridge signer PDA(s), 32 bytes, allowed as CCIP `sender`.
    mapping(bytes32 sender => bool allowed) public ccipSenders;

    /// Circle MessageTransmitterV2 on this chain, for `claimCctp`.
    address public cctpMessageTransmitter;

    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        __Ownable_init(_owner);
    }

    // ---------------------------------------------------------------- owner config

    /// Where `forward(token)` may send. Setting `address(0)` disables forwarding for that token.
    function setStrategy(address token, address target) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        strategy[token] = target;
        emit StrategySet(token, target);
    }

    /// Chainlink route: the router on this chain, the Solana selector, and the Solana sender to accept.
    function setCcipRoute(address router, uint64 sourceChainSelector, bytes32 sender, bool allowed) external onlyOwner {
        if (router == address(0) || sourceChainSelector == 0) revert ZeroAddress();
        ccipRouter = router;
        ccipSourceChainSelector = sourceChainSelector;
        ccipSenders[sender] = allowed;
        emit CcipSenderSet(sender, allowed);
    }

    function setCctpMessageTransmitter(address transmitter) external onlyOwner {
        if (transmitter == address(0)) revert ZeroAddress();
        cctpMessageTransmitter = transmitter;
    }

    // ---------------------------------------------------------------- inflows

    /// Chainlink calls this before `ccipReceive`; without it the router skips the call.
    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// CCIP delivery. The router has already transferred `destTokenAmounts` to this contract;
    /// this only checks the lane and records the arrival. Data is ignored on purpose.
    function ccipReceive(Any2EVMMessage calldata message) external override {
        if (msg.sender != ccipRouter) revert OnlyCcipRouter(msg.sender);
        if (message.sourceChainSelector != ccipSourceChainSelector) revert UnexpectedCcipSource(message.sourceChainSelector);
        if (message.sender.length != 32 || !ccipSenders[bytes32(message.sender)]) revert UnexpectedCcipSender();
        for (uint256 i = 0; i < message.destTokenAmounts.length; i++) {
            emit TokensReceived(message.messageId, message.destTokenAmounts[i].token, message.destTokenAmounts[i].amount);
        }
    }

    /// Finish a CCTP transfer whose Solana route set this contract as `destinationCaller`.
    /// `message` and `attestation` come from Circle's attestation API. Anyone may call it;
    /// the USDC is minted to this contract regardless of who calls.
    function claimCctp(bytes calldata message, bytes calldata attestation) external {
        if (cctpMessageTransmitter == address(0)) revert ZeroAddress();
        if (!IMessageTransmitterV2(cctpMessageTransmitter).receiveMessage(message, attestation)) revert CctpClaimFailed();
        emit CctpClaimed(keccak256(message));
    }

    // ---------------------------------------------------------------- outflow

    /// Move this contract's whole balance of `token` to its strategy. Anyone may call.
    function forward(address token) external {
        address target = strategy[token];
        if (target == address(0)) revert NoStrategy(token);
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToForward(token);
        IERC20(token).safeTransfer(target, amount);
        emit Forwarded(token, target, amount);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
