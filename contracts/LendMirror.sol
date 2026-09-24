// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { IOAppCore, ILayerZeroEndpointV2 } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppCore.sol";
import { IOAppReceiver } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppReceiver.sol";
import {
    IOAppOptionsType3,
    EnforcedOptionParam
} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";
import { PositionSnapshotMsgCodec } from "./libs/PositionSnapshotMsgCodec.sol";

error LzPayloadTooShort();
error InvalidPositionPayload();

/// One copy of a snapshot, as delivered by one router.
struct Delivery {
    PositionSnapshotMsgCodec.Snapshot snapshot;
    bytes32 bodyHash;
    bool received;
}

/// CCIP `ccipReceive` argument. Field types match Chainlink `Client.Any2EVMMessage`.
struct EVMTokenAmount {
    address token;
    uint256 amount;
}

struct Any2EVMMessage {
    bytes32 messageId;
    uint64 sourceChainSelector;
    bytes sender;
    bytes data;
    EVMTokenAmount[] destTokenAmounts;
}

/// Same function Chainlink uses to decide whether to call `ccipReceive`.
interface IAny2EVMMessageReceiver {
    function ccipReceive(Any2EVMMessage calldata message) external;
}

/// Ethereum receiver for LendMirror. Solana `send` is the LayerZero sender.
/// Solana `send_ccip` is the Chainlink sender. Both carry the same 225-byte body.
/// Deployed behind a UUPS proxy. Address stays the same when you upgrade logic.
/// Owner upgrades (`upgradeToAndCall`) and sets peers.
contract LendMirror is Initializable, OwnableUpgradeable, UUPSUpgradeable, IOAppCore, IOAppReceiver, IOAppOptionsType3 {
    uint16 internal constant OPTION_TYPE_3 = 3;
    uint64 internal constant RECEIVER_VERSION = 2;

    event PositionReceived(
        uint32 indexed srcEid,
        bytes32 indexed guid,
        uint16 vaultId,
        uint32 nftId,
        int64 snapshotTime,
        uint64 updatedTs,
        uint64 updatedBlock
    );

    event ChainlinkPositionReceived(bytes32 indexed messageId, bytes32 indexed position, uint16 vaultId, uint32 nftId);

    /// Emitted when both routers have delivered the same body for this position.
    event PositionsMatched(bytes32 indexed position, bytes32 bodyHash);

    /// LayerZero Endpoint on this chain. Fixed per implementation; set in constructor.
    ILayerZeroEndpointV2 public immutable endpoint;

    mapping(uint32 eid => bytes32 peer) public peers;
    mapping(uint32 eid => mapping(uint16 msgType => bytes enforcedOption)) public enforcedOptions;

    /// Latest LayerZero delivery. Kept so existing readers still see the LZ snapshot.
    PositionSnapshotMsgCodec.Snapshot internal lastPosition_;
    uint64 public lastUpdatedTs;
    uint64 public lastUpdatedBlock;

    /// CCIP router allowed to call `ccipReceive`. Set by the owner.
    address public ccipRouter;
    /// Solana chain selector CCIP puts on messages from our Store.
    uint64 public ccipSourceChainSelector;
    /// Solana account that signs `ccip_send`. It is the empty CCIP payer, not the Store.
    bytes public ccipSender;

    mapping(bytes32 position => Delivery) private layerZeroDelivery;
    mapping(bytes32 position => Delivery) private chainlinkDelivery;

    error OnlyEndpoint(address addr);
    error OnlyCcipRouter(address addr);
    error UnexpectedCcipSource(uint64 selector);
    error UnexpectedCcipSender();

    /// @param _endpoint LayerZero EndpointV2. Baked into this implementation.
    constructor(address _endpoint) {
        if (_endpoint == address(0)) revert InvalidDelegate();
        endpoint = ILayerZeroEndpointV2(_endpoint);
        _disableInitializers();
    }

    /// Call once on the proxy. `_owner` is owner, LZ delegate, and upgrade admin.
    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert InvalidDelegate();
        __Ownable_init(_owner);
        endpoint.setDelegate(_owner);
    }

    function lastPosition() external view returns (PositionSnapshotMsgCodec.Snapshot memory) {
        return lastPosition_;
    }

    /// `supply`, `borrow`, and `dustBorrow` after the exchange prices, matching Jupiter's read.
    function pricedPosition() external view returns (PositionSnapshotMsgCodec.Priced memory) {
        return PositionSnapshotMsgCodec.price(lastPosition_);
    }

    /// Owner tells this contract which CCIP router and Solana payer may deliver snapshots.
    function setCcipRoute(address router, uint64 sourceChainSelector, bytes calldata sender) external onlyOwner {
        if (router == address(0) || sourceChainSelector == 0 || sender.length == 0) revert UnexpectedCcipSender();
        ccipRouter = router;
        ccipSourceChainSelector = sourceChainSelector;
        ccipSender = sender;
    }

    function fromLayerZero(bytes32 position) external view returns (Delivery memory) {
        return layerZeroDelivery[position];
    }

    function fromChainlink(bytes32 position) external view returns (Delivery memory) {
        return chainlinkDelivery[position];
    }

    /// True only when both routers have delivered this position and the bodies are equal.
    function matched(bytes32 position) public view returns (bool) {
        Delivery storage lz = layerZeroDelivery[position];
        Delivery storage ccip = chainlinkDelivery[position];
        return lz.received && ccip.received && lz.bodyHash == ccip.bodyHash;
    }

    function oAppVersion() public pure returns (uint64 senderVersion, uint64 receiverVersion) {
        return (0, RECEIVER_VERSION);
    }

    function setPeer(uint32 _eid, bytes32 _peer) public virtual onlyOwner {
        peers[_eid] = _peer;
        emit PeerSet(_eid, _peer);
    }

    function setDelegate(address _delegate) public onlyOwner {
        endpoint.setDelegate(_delegate);
    }

    function setEnforcedOptions(EnforcedOptionParam[] calldata _enforcedOptions) public virtual onlyOwner {
        for (uint256 i = 0; i < _enforcedOptions.length; i++) {
            _assertOptionsType3(_enforcedOptions[i].options);
            enforcedOptions[_enforcedOptions[i].eid][_enforcedOptions[i].msgType] = _enforcedOptions[i].options;
        }
        emit EnforcedOptionSet(_enforcedOptions);
    }

    function combineOptions(
        uint32 _eid,
        uint16 _msgType,
        bytes calldata _extraOptions
    ) public view virtual returns (bytes memory) {
        bytes memory enforced = enforcedOptions[_eid][_msgType];
        if (enforced.length == 0) return _extraOptions;
        if (_extraOptions.length == 0) return enforced;
        if (_extraOptions.length >= 2) {
            _assertOptionsType3(_extraOptions);
            return bytes.concat(enforced, _extraOptions[2:]);
        }
        revert InvalidOptions(_extraOptions);
    }

    function isComposeMsgSender(
        Origin calldata /*_origin*/,
        bytes calldata /*_message*/,
        address _sender
    ) public view virtual returns (bool) {
        return _sender == address(this);
    }

    function allowInitializePath(Origin calldata origin) public view virtual returns (bool) {
        return peers[origin.srcEid] == origin.sender;
    }

    function nextNonce(uint32 /*_srcEid*/, bytes32 /*_sender*/) public view virtual returns (uint64 nonce) {
        return 0;
    }

    function lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) public payable virtual {
        if (address(endpoint) != msg.sender) revert OnlyEndpoint(msg.sender);
        bytes32 peer = peers[_origin.srcEid];
        if (peer == bytes32(0)) revert NoPeer(_origin.srcEid);
        if (peer != _origin.sender) revert OnlyPeer(_origin.srcEid, _origin.sender);
        _lzReceive(_origin, _guid, _message, _executor, _extraData);
    }

    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata payload,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal virtual {
        if (payload.length < 32) revert LzPayloadTooShort();
        lastPosition_ = _writeDelivery(layerZeroDelivery, payload);
        lastUpdatedTs = uint64(block.timestamp);
        lastUpdatedBlock = uint64(block.number);
        emit PositionReceived(
            _origin.srcEid,
            _guid,
            lastPosition_.vaultId,
            lastPosition_.nftId,
            lastPosition_.snapshotTime,
            lastUpdatedTs,
            lastUpdatedBlock
        );
    }

    /// Chainlink asks this before it will call `ccipReceive`. A missing answer makes it skip the call.
    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// Chainlink router entry. `message.data` is the same 225-byte body LayerZero frames.
    function ccipReceive(Any2EVMMessage calldata message) external {
        if (msg.sender != ccipRouter) revert OnlyCcipRouter(msg.sender);
        if (message.sourceChainSelector != ccipSourceChainSelector) {
            revert UnexpectedCcipSource(message.sourceChainSelector);
        }
        if (keccak256(message.sender) != keccak256(ccipSender)) revert UnexpectedCcipSender();
        PositionSnapshotMsgCodec.Snapshot memory snapshot = _writeDelivery(chainlinkDelivery, message.data);
        emit ChainlinkPositionReceived(message.messageId, snapshot.position, snapshot.vaultId, snapshot.nftId);
    }

    function _writeDelivery(
        mapping(bytes32 => Delivery) storage slot,
        bytes calldata payload
    ) internal returns (PositionSnapshotMsgCodec.Snapshot memory snapshot) {
        bytes calldata body = PositionSnapshotMsgCodec.snapshotBody(payload);
        snapshot = PositionSnapshotMsgCodec.decodeBody(body);
        bytes32 bodyHash = keccak256(body);
        slot[snapshot.position] = Delivery({ snapshot: snapshot, bodyHash: bodyHash, received: true });
        if (matched(snapshot.position)) emit PositionsMatched(snapshot.position, bodyHash);
    }

    function _assertOptionsType3(bytes memory _options) internal pure {
        uint16 optionsType;
        assembly {
            optionsType := mload(add(_options, 2))
        }
        if (optionsType != OPTION_TYPE_3) revert InvalidOptions(_options);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
