// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OApp, MessagingFee, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { StringMsgCodec } from "./libs/StringMsgCodec.sol";

/// LendMirror Piece 1 — Ethereum side of a LayerZero OApp.
///
/// LayerZero is not a chain. It is a messaging protocol already deployed on
/// many chains. An OApp is OUR contract that uses it.
///
/// This file is the Ethereum half (Solidity). The Solana half is
/// programs/lendmirror (Rust). We need both because Ethereum cannot run Solana
/// programs and Solana cannot run this Solidity.
///
/// They never call each other. Each calls the LayerZero Endpoint on its own
/// chain (address passed into the constructor). The Endpoint is LayerZero's
/// contract, not ours.
///
/// Right now this example can send a string either way. LendMirror only needs
/// Solana → Ethereum. So on THIS file, the function that matters is
/// `_lzReceive`. Solana's `send` (in programs/lendmirror) is the sender.
///
///   send        — would send FROM Ethereum. The starter includes it.
///                 LendMirror does not use it for the loan snapshot.
///   _lzReceive  — bytes arriving FROM Solana land here. We do not call this.
///                 The Endpoint calls it after DVNs agree the packet is real.
contract LendMirror is OApp, OAppOptionsType3 {
    using StringMsgCodec for bytes;

    /// @param _endpoint LayerZero's mailbox already deployed on this chain.
    ///                  We do not deploy the mailbox. We only point at it.
    /// @param _delegate The owner. Can set peers (which remote contract we
    ///                  trust) and other config. A random wallet cannot.
    constructor(address _endpoint, address _delegate) OApp(_endpoint, _delegate) Ownable(_delegate) {}

    /// Last string this contract received from another chain.
    /// Anyone can read it. Only _lzReceive can write it.
    /// Later this becomes a mapping of loan snapshots instead of one string.
    string public data = "Nothing received yet.";

    /// Sends a string FROM this Ethereum contract TO another chain.
    ///
    /// The official starter ships this so the example is two-way. LendMirror's
    /// loan snapshot does not use it. The snapshot is sent from Solana.
    ///
    /// Payable because the fee is ETH on this chain. Call quote() first.
    /// Leftover ETH is refunded to msg.sender.
    function send(
        uint32 _dstEid,
        string calldata _string,
        bytes calldata _options
    ) external payable returns (MessagingReceipt memory receipt) {
        // Turn the string into bytes the other chain can decode.
        bytes memory _message = abi.encodePacked(abi.encode(uint256(bytes(_string).length)), bytes(_string));
        bytes memory options = combineOptions(_dstEid, StringMsgCodec.VANILLA_TYPE, _options);

        // Hand the packet to the Endpoint. We are done after this line.
        // Delivery on the other chain happens later, after DVNs verify.
        receipt = _lzSend(_dstEid, _message, options, MessagingFee(msg.value, 0), payable(msg.sender));
    }

    /// How much native token to attach to send(). View-only: it does not send.
    ///
    /// @param _payInLzToken false = pay in ETH/SOL. true = pay in ZRO (we will
    ///                      not use that). The return value is nativeFee + lzTokenFee.
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

    /// LayerZero calls this after DVNs have verified the packet.
    ///
    /// It is internal. A wallet cannot call it. The parent OApp only lets the
    /// Endpoint in, and only if:
    ///   1. checkers verified the hash
    ///   2. the sender is the peer we configured (the Solana OApp, not a stranger)
    ///
    /// If those checks fail, this function never runs. That is why we do not
    /// add a second "require verified" check of our own.
    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata payload,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        string memory stringValue = StringMsgCodec.decode(payload);
        data = stringValue;
    }
}
