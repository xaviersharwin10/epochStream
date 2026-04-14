# ⚡ Epochstream — Universal HSP Payment Router

> **A universal Web3 PayFi router** where users seamlessly purchase digital resources across DeFi, DePIN, and SaaS verticals — powered by HashKey Settlement Protocol (HSP).

🌐 **Live Demo:** [https://epoch-stream.vercel.app](https://epoch-stream.vercel.app)  
📦 **Repository:** [https://github.com/xaviersharwin10/epochStream](https://github.com/xaviersharwin10/epochStream)  
🏆 **Track:** PayFi — HashKey On-Chain Horizon Hackathon 2026

---

## 💡 What is Epochstream?

Epochstream is a **Universal Digital Resource Router** that demonstrates how HSP can power real-world, frictionless payment flows for everyday users. When a user requests digital resources (like an AI model prompt or a trading signal), the provider issues an HTTP 402 Payment Required invoice. Epochstream routes the payment through HSP — generating an on-chain USDT settlement on HashKey Chain — and delivers the data the moment the webhook confirms the transaction.

By leveraging **Reusable Mandates (multi_pay)**, Epochstream completely eliminates the need for users to manually sign transactions for recurring services, laying the precise technical foundation for **fully autonomous Machine-to-Machine (M2M) payments in the future.**

---

## 🏗 Architecture

![Epochstream System Architecture](./architecture.svg)


---

## 🔄 Sequence Diagrams

### Single Payment (One-Time)

```mermaid
sequenceDiagram
    participant A as Agent A (Browser)
    participant B as Epochstream Backend
    participant H as HashKey Merchant API
    participant C as HashKey Chain
    participant W as Webhook Handler

    A->>B: GET /api/premium-data (no voucher)
    B-->>A: 402 Payment Required {intentId, price}
    A->>B: POST /api/checkout-url {intentId, amount}
    B->>H: POST /merchant/orders (HMAC signed, ES256K JWT)
    H-->>B: {payment_url, payment_request_id}
    B-->>A: {paymentUrl}
    A->>H: Opens checkout URL, signs EIP-712 in wallet
    H->>C: Broadcasts USDT transfer on-chain
    C-->>H: Transaction confirmed
    H->>W: POST /webhook/hsp (HMAC signed, status=payment-included)
    W->>W: Validates HMAC, issues HSP voucher
    A->>B: GET /api/status?intentId={id} (polling)
    B-->>A: {status: LOCKED_AND_VERIFIED, voucherId, txHash}
    A->>B: GET /api/premium-data (X-HSP-Voucher-ID header)
    B-->>A: 200 OK — Premium data delivered
```

### Subscription Flow (Reusable Mandate)

```mermaid
sequenceDiagram
    participant A as Agent A (Browser)
    participant B as Epochstream Backend
    participant H as HashKey Merchant API
    participant C as HashKey Chain
    participant W as Webhook Handler

    Note over A,W: Day 1 — Mandate Creation
    A->>B: POST /api/subscribe {intentId, amount}
    B->>H: POST /merchant/orders/reusable (cart_mandate_id, multi_pay=true)
    H-->>B: {payment_url, multi_pay: true}
    B-->>A: {paymentUrl, subscriptionId}
    A->>H: Opens checkout, signs EIP-712 mandate (30-day scope)
    H->>C: Broadcasts Day 1 charge on-chain
    H->>W: Webhook {payment_request_id: PAY-id-charge1, status: payment-included}
    W->>W: Voucher issued for charge1
    A->>B: GET /api/premium-data?type=trading (voucher)
    B-->>A: Day 1 signal delivered

    Note over A,W: Day 2 — Reusable Mandate (same cart_mandate_id)
    A->>B: POST /api/subscription/charge {subscriptionId}
    B->>H: POST /merchant/orders/reusable (same cart_mandate_id, new payment_request_id: PAY-id-charge2)
    H-->>B: {payment_url, multi_pay: true}
    A->>H: Confirms Day 2 payment (existing mandate, no re-authorization)
    H->>C: Broadcasts Day 2 charge on-chain
    H->>W: Webhook {payment_request_id: PAY-id-charge2, status: payment-finalized}
    W->>W: Voucher issued for charge2
    A->>B: GET /api/premium-data?type=trading (voucher)
    B-->>A: Day 2 signal delivered
```

---

## 🔐 HSP Integration Deep-Dive

Epochstream implements the full HashKey Merchant AP2 specification:

| Component | Implementation |
|---|---|
| **Cart Mandate** | Built per RFC 8785 canonical JSON, SHA-256 hashed |
| **Merchant Auth JWT** | ES256K (secp256k1) signed with merchant private key |
| **HMAC Request Auth** | HMAC-SHA256 with nonce + timestamp replay protection |
| **Webhook Verification** | HMAC-SHA256 on raw body with `t=` timestamp tolerance |
| **Reusable Mandates** | `POST /merchant/orders/reusable` with unique `payment_request_id` per charge |
| **Supported Statuses** | `payment-included`, `payment-successful`, `payment-safe`, `payment-finalized` |
| **On-Chain Settlement** | USDT on HashKey Chain Testnet (Chain ID: 133) |

---

## 💎 Value Proposition

| User Persona | Real-World Scenario | Quantifiable Impact |
|---|---|---|
| 🧑‍💹 **Quant Trader** | Subscribes to daily AI-powered HSK/BTC/ETH oracle signals, auto-billed via reusable mandate | Eliminates $50+/month SaaS subscriptions; pays $0.50 per signal, only when consumed |
| 🚗 **EV Driver** | Plugs into DePIN charging station; IoT agent auto-pays per kWh via HSP without human interaction | Zero friction checkout; 100% autonomous M2M settlement in <2 seconds on HashKey Chain |
| 🤖 **AI Developer** | SaaS metered billing for LLM API calls; pay-per-1M-tokens instead of locked monthly plans | Eliminates $240/year wasted subscription overage; true pay-per-use enforced on-chain |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- A HashKey Merchant account (QA environment credentials)
- MetaMask with HashKey Testnet configured

### 1. Clone the Repository

```bash
git clone https://github.com/xaviersharwin10/epochStream.git
cd epochStream
```

### 2. Backend Setup

```bash
cd backend
npm install
```

Create a `.env` file:

```env
PORT=3001
HASHKEY_TESTNET_RPC=https://hashkey-testnet-rpc-url
CONTRACT_ADDRESS=0x5765B13165180F5d99E8C8741Cd082F9cDb61F5C
HSP_APP_KEY=your_hsp_app_key
HSP_API_SECRET=your_hsp_api_secret
MERCHANT_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----"
FRONTEND_URL=http://localhost:3000
```

```bash
npm run dev
```

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 4. Environment Variables (Production — Railway)

| Variable | Description |
|---|---|
| `HASHKEY_TESTNET_RPC` | HashKey Chain Testnet RPC endpoint |
| `CONTRACT_ADDRESS` | Deployed Epochstream escrow contract |
| `HSP_APP_KEY` | HashKey Merchant app key |
| `HSP_API_SECRET` | HashKey Merchant HMAC secret |
| `MERCHANT_PRIVATE_KEY` | secp256k1 PEM private key for JWT signing |
| `FRONTEND_URL` | Vercel deployment URL (for redirect callback) |

---

## 📁 Project Structure

```
epochstream/
├── frontend/          # Next.js 14 — Vercel deployment
│   └── src/app/
│       └── page.tsx   # Unified 3-column dashboard UI
├── backend/           # Express + TypeScript — Railway deployment
│   └── server.ts      # HSP integration, webhook handler, seller API
└── contracts/         # Solidity escrow contract (HashKey Chain)
    └── scripts/
        └── deploy.js
```

---

## 🌐 Deployment

| Service | Platform | URL |
|---|---|---|
| Frontend | Vercel | https://epoch-stream.vercel.app |
| Backend | Railway | https://epochstream-production.up.railway.app |
| Smart Contract | HashKey Testnet | `0x5765B13165180F5d99E8C8741Cd082F9cDb61F5C` |

---

## ⛓ Live On-Chain Transactions

Real USDT settlements made via Epochstream on **HashKey Chain Testnet**, triggered through the HSP payment flow:

| # | Transaction |
|---|---|
| 1 | [0x7fe77e39...bee589b9](https://testnet-explorer.hsk.xyz/tx/0x7fe77e39b396a0102b4b6fd80cea4c8bd5db80a9be2268a11d735766bee589b9) |
| 2 | [0x05b82628...bd64f0f6](https://testnet-explorer.hsk.xyz/tx/0x05b82628eb1d6a83595f6578741d7396b4328407f52b6a7642738ce3bd64f0f6) |
| 3 | [0x5a5c8489...2e96964a](https://testnet-explorer.hsk.xyz/tx/0x5a5c84895044b9995a7fe1b8299dcd668fb27a7586502a98ce431edb2e96964a) |
| 4 | [0xf7c75a98...a8e50b03](https://testnet-explorer.hsk.xyz/tx/0xf7c75a98c15d16c6f2e3813ead802a7397b8bd8c92fcabb345129b07a8e50b03) |
| 5 | [0x72b4e0eb...78d82042](https://testnet-explorer.hsk.xyz/tx/0x72b4e0ebd2c0e8ee2a451cd2b9d57443275fbd28acb945e2f215f44878d82042) |

> Each transaction represents a complete HSP settlement cycle: HTTP 402 → Cart Mandate → HMAC-signed order → EIP-712 wallet signature → on-chain USDT transfer → HMAC-verified webhook → data delivery.

## 🏆 Hackathon

**HashKey Chain On-Chain Horizon Hackathon 2026**  
Track: **PayFi** | Prize Pool: **10,000 USDT**  
Submission Deadline: **Apr 15, 2026 23:59 GMT+8**

Built with ❤️ using HSP (HashKey Settlement Protocol)
