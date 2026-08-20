// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Outside Docker Anchor
/// @notice Stores only batch commitments. No plaintext payloads or ciphertexts are stored on-chain.
contract ODAnchor {
    error NotOwner();
    error ZeroValue();
    error BatchAlreadyAnchored();
    error PendingOwnerOnly();

    struct Anchor {
        bytes32 merkleRoot;
        bytes32 manifestHash;
        uint64 anchoredAt;
        uint32 leafCount;
        uint32 eventCount;
    }

    address public owner;
    address public pendingOwner;
    uint256 public nextAnchorId;

    mapping(uint256 => Anchor) public anchors;
    mapping(bytes32 => uint256) public anchorIdByBatch;

    event AnchorBatch(
        uint256 indexed anchorId,
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        bytes32 manifestHash,
        uint32 leafCount,
        uint32 eventCount,
        uint64 anchoredAt
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroValue();
        owner = initialOwner;
    }

    function anchorBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        bytes32 manifestHash,
        uint32 leafCount,
        uint32 eventCount
    ) external onlyOwner returns (uint256 anchorId) {
        if (batchId == bytes32(0) || merkleRoot == bytes32(0) || manifestHash == bytes32(0)) revert ZeroValue();
        if (anchorIdByBatch[batchId] != 0) revert BatchAlreadyAnchored();
        anchorId = ++nextAnchorId;
        uint64 timestamp = uint64(block.timestamp);
        anchors[anchorId] = Anchor(merkleRoot, manifestHash, timestamp, leafCount, eventCount);
        anchorIdByBatch[batchId] = anchorId;
        emit AnchorBatch(anchorId, batchId, merkleRoot, manifestHash, leafCount, eventCount, timestamp);
    }

    function verify(uint256 anchorId, bytes32 merkleRoot, bytes32 manifestHash) external view returns (bool) {
        if (anchorId == 0 || anchorId > nextAnchorId) return false;
        Anchor memory a = anchors[anchorId];
        return a.merkleRoot == merkleRoot && a.manifestHash == manifestHash;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert PendingOwnerOnly();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }
}
