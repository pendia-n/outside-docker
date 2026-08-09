// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ODAnchor} from "../src/ODAnchor.sol";

contract ODAnchorTest {
    ODAnchor anchor;
    bytes32 batchId = keccak256("batch-1");
    bytes32 root = keccak256("root-1");

    function setUp() public { anchor = new ODAnchor(); }

    function testAnchorAndVerify() public {
        anchor.anchor(batchId, root, 3);
        require(anchor.verify(batchId, root), "root should verify");
    }

    function testDuplicateBatchReverts() public {
        anchor.anchor(batchId, root, 3);
        try anchor.anchor(batchId, root, 3) { revert("duplicate accepted"); } catch {}
    }

    function testWrongRootFails() public {
        anchor.anchor(batchId, root, 3);
        require(!anchor.verify(batchId, keccak256("wrong")), "wrong root verified");
    }
}
