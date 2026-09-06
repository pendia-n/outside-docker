// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OutDock Anchor
/// @notice Stores aggregate evidence-batch commitments only. No evidence, plaintext,
/// ciphertext, content hash, salt, passcode, payment, or verifier grant is stored here.
contract OutDock {
    error NotOwner();
    error NotAnchorer();
    error ZeroValue();
    error EmptyBatch();
    error BatchAlreadyAnchored();
    error PendingOwnerOnly();
    error AnchoringPaused();

    uint32 public constant CONTRACT_VERSION = 2;

    struct Anchor {
        bytes32 merkleRoot;
        bytes32 manifestHash;
        uint64 anchoredAt;
        uint32 leafCount;
        uint32 eventCount;
        bytes4 protocolId;
    }

    address public owner;
    address public pendingOwner;
    uint256 public nextAnchorId;
    bool public anchoringPaused;

    mapping(address => bool) public anchorers;
    mapping(uint256 => Anchor) public anchors;
    mapping(bytes32 => uint256) public anchorIdByBatch;

    // Kept byte-for-byte compatible with ODAnchor so existing proof readers can
    // continue to validate historical and new receipts with the same event ABI.
    event AnchorBatch(
        uint256 indexed anchorId,
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        bytes32 manifestHash,
        uint32 leafCount,
        uint32 eventCount,
        uint64 anchoredAt
    );
    event AnchorProtocol(
        uint256 indexed anchorId,
        bytes32 indexed batchId,
        bytes4 indexed protocolId,
        address submittedBy
    );
    event AnchorerUpdated(address indexed account, bool allowed);
    event AnchoringPauseUpdated(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAnchorer() {
        if (!anchorers[msg.sender]) revert NotAnchorer();
        _;
    }

    constructor(address initialOwner, address initialAnchorer) {
        if (initialOwner == address(0) || initialAnchorer == address(0)) revert ZeroValue();
        owner = initialOwner;
        anchorers[initialAnchorer] = true;
        emit OwnershipTransferred(address(0), initialOwner);
        emit AnchorerUpdated(initialAnchorer, true);
    }

    /// @notice Records one immutable batch commitment.
    /// @param protocolId Protocol discriminator, for example bytes4("OD1") or bytes4("OD2").
    function anchorBatch(
        bytes4 protocolId,
        bytes32 batchId,
        bytes32 merkleRoot,
        bytes32 manifestHash,
        uint32 leafCount,
        uint32 eventCount
    ) external onlyAnchorer returns (uint256 anchorId) {
        if (anchoringPaused) revert AnchoringPaused();
        if (
            protocolId == bytes4(0) || batchId == bytes32(0) || merkleRoot == bytes32(0)
                || manifestHash == bytes32(0)
        ) revert ZeroValue();
        if (leafCount == 0 || eventCount == 0) revert EmptyBatch();
        if (anchorIdByBatch[batchId] != 0) revert BatchAlreadyAnchored();

        anchorId = ++nextAnchorId;
        uint64 timestamp = uint64(block.timestamp);
        anchors[anchorId] = Anchor(merkleRoot, manifestHash, timestamp, leafCount, eventCount, protocolId);
        anchorIdByBatch[batchId] = anchorId;

        emit AnchorBatch(anchorId, batchId, merkleRoot, manifestHash, leafCount, eventCount, timestamp);
        emit AnchorProtocol(anchorId, batchId, protocolId, msg.sender);
    }

    /// @notice Backward-compatible commitment verification used by existing proof readers.
    function verify(uint256 anchorId, bytes32 merkleRoot, bytes32 manifestHash) external view returns (bool) {
        if (anchorId == 0 || anchorId > nextAnchorId) return false;
        Anchor storage anchor = anchors[anchorId];
        return anchor.merkleRoot == merkleRoot && anchor.manifestHash == manifestHash;
    }

    /// @notice Verifies the complete public batch commitment, including its protocol and counts.
    function verifyBatch(
        bytes32 batchId,
        bytes4 protocolId,
        bytes32 merkleRoot,
        bytes32 manifestHash,
        uint32 leafCount,
        uint32 eventCount
    ) external view returns (bool) {
        uint256 anchorId = anchorIdByBatch[batchId];
        if (anchorId == 0) return false;
        Anchor storage anchor = anchors[anchorId];
        return anchor.protocolId == protocolId && anchor.merkleRoot == merkleRoot
            && anchor.manifestHash == manifestHash && anchor.leafCount == leafCount
            && anchor.eventCount == eventCount;
    }

    /// @notice Grants or revokes a Worker hot wallet without changing contract ownership.
    function setAnchorer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroValue();
        anchorers[account] = allowed;
        emit AnchorerUpdated(account, allowed);
    }

    /// @notice Stops new submissions without affecting already anchored batches.
    function setAnchoringPaused(bool paused) external onlyOwner {
        anchoringPaused = paused;
        emit AnchoringPauseUpdated(paused);
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
