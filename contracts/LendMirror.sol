// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
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

/// Ethereum receiver for LendMirror. Solana `send` is the sender.
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

    /// LayerZero Endpoint on this chain. Fixed per implementation; set in constructor.
    ILayerZeroEndpointV2 public immutable endpoint;

    mapping(uint32 eid => bytes32 peer) public peers;
    mapping(uint32 eid => mapping(uint16 msgType => bytes enforcedOption)) public enforcedOptions;

    PositionSnapshotMsgCodec.Snapshot internal lastPosition_;
    uint64 public lastUpdatedTs;
    uint64 public lastUpdatedBlock;

    error OnlyEndpoint(address addr);

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
        uint256 declared = uint256(bytes32(payload[0:32]));
        if (declared != PositionSnapshotMsgCodec.BODY_LEN) revert InvalidPositionPayload();
        lastPosition_ = PositionSnapshotMsgCodec.decode(payload);
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

    function _assertOptionsType3(bytes memory _options) internal pure {
        uint16 optionsType;
        assembly {
            optionsType := mload(add(_options, 2))
        }
        if (optionsType != OPTION_TYPE_3) revert InvalidOptions(_options);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
