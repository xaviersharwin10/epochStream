// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EpochstreamRouter
 * @dev Intent-based, Machine-to-Machine (M2M) payment router for HashKey Chain.
 * Facilitates autonomous crypto payments between AI agents.
 */
contract EpochstreamRouter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    enum IntentStatus { NONE, LOCKED, RELEASED, REFUNDED }

    struct Intent {
        address buyer;
        address seller;
        address token; // address(0) for native token (e.g., HSK)
        uint256 amount;
        IntentStatus status;
        uint256 lockedAt;
    }

    // Mapping intentId to Intent details
    mapping(bytes32 => Intent) public intents;
    
    // Configurable timeout for refunds (e.g., 24 hours)
    uint256 public refundTimeout = 24 hours;

    // Events for backend listeners (HSP webhook validators)
    event FundsLocked(
        bytes32 indexed intentId, 
        address indexed buyer, 
        address indexed seller, 
        address token,
        uint256 amount
    );
    event FundsReleased(
        bytes32 indexed intentId, 
        address indexed seller, 
        address token,
        uint256 amount
    );
    event FundsRefunded(
        bytes32 indexed intentId, 
        address indexed buyer, 
        address token,
        uint256 amount
    );

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Agent A (Buyer) locks funds referencing a specific intentId.
     * @param intentId Unique ID mapped from the 402 Payment Required response
     * @param seller The AI Agent B wallet address to receive the funds
     * @param token The ERC20 token address (or address(0) for native token)
     * @param amount The cost of the requested data in token units
     */
    function lockFunds(
        bytes32 intentId, 
        address seller, 
        address token, 
        uint256 amount
    ) external payable nonReentrant {
        require(intents[intentId].status == IntentStatus.NONE, "Intent already exists");
        require(seller != address(0), "Invalid seller address");
        require(amount > 0, "Amount must be greater than zero");

        if (token == address(0)) {
            require(msg.value == amount, "Incorrect native token value sent");
        } else {
            require(msg.value == 0, "Native tokens sent for ERC20 payment");
            // Pull funds from the buyer (requires prior approval)
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        intents[intentId] = Intent({
            buyer: msg.sender,
            seller: seller,
            token: token,
            amount: amount,
            status: IntentStatus.LOCKED,
            lockedAt: block.timestamp
        });

        emit FundsLocked(intentId, msg.sender, seller, token, amount);
    }

    /**
     * @dev Unlocks funds to the seller after they deliver off-chain data.
     * Requires cryptographic proof from Agent B (the seller).
     * @param intentId The UUID of the intent being finalized
     * @param signature The ECDSA signature over (intentId, address(this)) signed by the seller
     */
    function releaseFunds(bytes32 intentId, bytes calldata signature) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.status == IntentStatus.LOCKED, "Intent not locked");

        // The exact message the seller must sign to authorize fund release
        // We include `address(this)` to prevent cross-contract replay attacks
        bytes32 messageHash = keccak256(abi.encodePacked(intentId, address(this)));
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        
        // Recover the signer address
        address signer = ethSignedMessageHash.recover(signature);
        require(signer == intent.seller, "Invalid cryptographic proof from seller");

        intent.status = IntentStatus.RELEASED;

        // Push funds to the seller
        if (intent.token == address(0)) {
            (bool success, ) = payable(intent.seller).call{value: intent.amount}("");
            require(success, "Native transfer failed");
        } else {
            IERC20(intent.token).safeTransfer(intent.seller, intent.amount);
        }

        emit FundsReleased(intentId, intent.seller, intent.token, intent.amount);
    }

    /**
     * @dev Allows refunds if the seller fails to deliver data within the timeout period
     * @param intentId The intent to refund
     */
    function refundFunds(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        require(intent.status == IntentStatus.LOCKED, "Intent not locked");
        require(msg.sender == intent.buyer, "Only buyer can request refund");
        require(block.timestamp >= intent.lockedAt + refundTimeout, "Refund timeout not met");

        intent.status = IntentStatus.REFUNDED;

        if (intent.token == address(0)) {
            (bool success, ) = payable(intent.buyer).call{value: intent.amount}("");
            require(success, "Native transfer failed");
        } else {
            IERC20(intent.token).safeTransfer(intent.buyer, intent.amount);
        }

        emit FundsRefunded(intentId, intent.buyer, intent.token, intent.amount);
    }

    /**
     * @dev Admin function to update the refund timeout duration
     */
    function setRefundTimeout(uint256 _timeout) external onlyOwner {
        refundTimeout = _timeout;
    }
}
