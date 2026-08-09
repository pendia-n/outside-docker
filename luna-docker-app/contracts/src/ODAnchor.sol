// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ODAnchor {
    address public immutable owner;

    struct Anchor {
        bytes32 merkleRoot;
        uint256 leafCount;
        uint256 timestamp;
        bool exists;
    }

    mapping(bytes32 => Anchor) public anchors;

    event AnchorBatch(
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        uint256 leafCount,
        uint256 timestamp
    );

    error OnlyOwner();
    error DuplicateBatch();
    error EmptyRoot();

    constructor() { owner = msg.sender; }

    function anchor(bytes32 batchId, bytes32 merkleRoot, uint256 leafCount) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (merkleRoot == bytes32(0)) revert EmptyRoot();
        if (anchors[batchId].exists) revert DuplicateBatch();
        uint256 nowTimestamp = block.timestamp;
        anchors[batchId] = Anchor(merkleRoot, leafCount, nowTimestamp, true);
        emit AnchorBatch(batchId, merkleRoot, leafCount, nowTimestamp);
    }

    function verify(bytes32 batchId, bytes32 merkleRoot) external view returns (bool) {
        Anchor memory item = anchors[batchId];
        return item.exists && item.merkleRoot == merkleRoot;
    }
}
