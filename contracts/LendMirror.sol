// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OApp, MessagingFee, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { StringMsgCodec } from "./libs/StringMsgCodec.sol";
import { PythPriceMsgCodec } from "./libs/PythPriceMsgCodec.sol";
import { PositionSnapshotMsgCodec } from "./libs/PositionSnapshotMsgCodec.sol";

error UnknownLzPayload();
error LzPayloadTooShort();

/// Ethereum receiver for LendMirror. Solana `send` is the sender.
/// `_lzReceive` picks Pyth vs position from the 32-byte length header.
contract LendMirror is OApp, OAppOptionsType3 {
    constructor(address _endpoint, address _delegate) OApp(_endpoint, _delegate) Ownable(_delegate) {}

    /// Last Pyth snapshot received from Solana.
    PythPriceMsgCodec.Snapshot public lastPrice;

    /// Last Jupiter position snapshot received from Solana.
    PositionSnapshotMsgCodec.Snapshot internal lastPosition_;

    function lastPosition() external view returns (PositionSnapshotMsgCodec.Snapshot memory) {
        return lastPosition_;
    }

    /// Starter leftover: send a string FROM Ethereum. LendMirror does not use this for prices.
    function send(
        uint32 _dstEid,
        string calldata _string,
        bytes calldata _options
    ) external payable returns (MessagingReceipt memory receipt) {
        bytes memory _message = abi.encodePacked(abi.encode(uint256(bytes(_string).length)), bytes(_string));
        bytes memory options = combineOptions(_dstEid, StringMsgCodec.VANILLA_TYPE, _options);
        receipt = _lzSend(_dstEid, _message, options, MessagingFee(msg.value, 0), payable(msg.sender));
    }

    function quote(
        uint32 _dstEid,
        string calldata _message,
        bytes calldata _options,
        bool _payInLzToken
    ) public view returns (MessagingFee memory fee) {
        bytes memory payload = abi.encodePacked(abi.encode(uint256(bytes(_message).length)), bytes(_message));
        bytes memory options = combineOptions(_dstEid, StringMsgCodec.VANILLA_TYPE, _options);
        fee = _quote(_dstEid, payload, options, _payInLzToken);
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
        if (declared == PythPriceMsgCodec.BODY_LEN) {
            lastPrice = PythPriceMsgCodec.decode(payload);
        } else if (declared == PositionSnapshotMsgCodec.BODY_LEN) {
            lastPosition_ = PositionSnapshotMsgCodec.decode(payload);
        } else {
            revert UnknownLzPayload();
        }
    }
}
