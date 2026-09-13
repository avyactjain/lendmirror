// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OApp, MessagingFee, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { StringMsgCodec } from "./libs/StringMsgCodec.sol";
import { PythPriceMsgCodec } from "./libs/PythPriceMsgCodec.sol";

/// Ethereum receiver for LendMirror. Solana `send` is the sender.
/// `_lzReceive` stores the last Pyth snapshot unpacked from the Solana payload.
contract LendMirror is OApp, OAppOptionsType3 {
    constructor(address _endpoint, address _delegate) OApp(_endpoint, _delegate) Ownable(_delegate) {}

    /// Last Pyth snapshot received from Solana.
    PythPriceMsgCodec.Snapshot public lastPrice;

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
        lastPrice = PythPriceMsgCodec.decode(payload);
    }
}
