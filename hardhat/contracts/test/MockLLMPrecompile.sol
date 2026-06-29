// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockLLMPrecompile {
    struct ConvoHistory {
        string storageType;
        string path;
        string secretsName;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        bytes memory actualOutput = abi.encode(
            false,
            bytes("mock ai review"),
            bytes(""),
            "",
            ConvoHistory("", "", "")
        );

        return abi.encode(bytes("simulated input"), actualOutput);
    }
}
