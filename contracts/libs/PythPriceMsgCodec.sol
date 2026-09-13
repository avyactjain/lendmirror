// SPDX-License-Identifier: MIT

pragma solidity ^0.8.22;

error PythMsgTooShort();
error PythInvalidBodyLength();

/// Same layout as `impl LzMessage for PythPrice` on Solana.
///
/// [32-byte length header][92-byte body]
/// Body, big-endian:
///   bytes32 pythAccount | bytes32 feedId | int64 price | uint64 conf | int32 exponent | int64 publishTime
library PythPriceMsgCodec {
    uint8 public constant VANILLA_TYPE = 1;
    uint256 internal constant HEADER_LEN = 32;
    uint256 internal constant BODY_LEN = 92;

    struct Snapshot {
        bytes32 pythAccount;
        bytes32 feedId;
        int64 price;
        uint64 conf;
        int32 exponent;
        int64 publishTime;
    }

    function decode(bytes calldata _msg) internal pure returns (Snapshot memory s) {
        if (_msg.length < HEADER_LEN) revert PythMsgTooShort();

        uint256 declared = uint256(bytes32(_msg[0:HEADER_LEN]));
        if (declared != BODY_LEN || _msg.length < HEADER_LEN + BODY_LEN) revert PythInvalidBodyLength();

        bytes calldata body = _msg[HEADER_LEN:HEADER_LEN + BODY_LEN];
        s.pythAccount = bytes32(body[0:32]);
        s.feedId = bytes32(body[32:64]);
        s.price = int64(uint64(bytes8(body[64:72])));
        s.conf = uint64(bytes8(body[72:80]));
        s.exponent = int32(uint32(bytes4(body[80:84])));
        s.publishTime = int64(uint64(bytes8(body[84:92])));
    }
}
