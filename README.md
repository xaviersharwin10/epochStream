# ⚡ Epochstream — Universal HSP Payment Router

> **A real-time M2M PayFi marketplace** where AI agents autonomously buy and sell premium data across DeFi, DePIN, and SaaS verticals — powered by HashKey Settlement Protocol (HSP).

🌐 **Live Demo:** [https://epoch-stream.vercel.app](https://epoch-stream.vercel.app)  
📦 **Repository:** [https://github.com/xaviersharwin10/epochStream](https://github.com/xaviersharwin10/epochStream)  
🏆 **Track:** PayFi — HashKey On-Chain Horizon Hackathon 2026

---

## 💡 What is Epochstream?

Epochstream is a **Universal M2M Payment Router** that demonstrates how HSP can power real-world, autonomous payment flows. A buyer AI agent (Agent A) requests premium data from a seller agent (Agent B). Agent B issues an HTTP 402 Payment Required. Agent A routes the payment through HSP — generating an on-chain USDT settlement on HashKey Chain — and receives live data the moment the webhook confirms the transaction.

The same HSP payment infrastructure handles **three distinct real-world verticals** in a single demo:

| Use Case | Vertical | Payment Type |
|---|---|---|
| 🔮 HashKey Oracle Trading Signal | DeFi | One-time / Reusable Mandate |
| 🚗 IoT EV Charging Auto-Pay | DePIN | Per-session M2M |
| 🤖 AI Compute Pay-per-Use | SaaS | Metered billing |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Epochstream Platform                        │
│                                                                 │
│  ┌──────────────┐    HTTP 402     ┌──────────────────────────┐  │
│  │  Agent A     │ ─────────────► │  Agent B (Seller API)    │  │
│  │ (Buyer UI)   │                │  /api/premium-data       │  │
│  │              │ ◄────────────  │  Returns 402 + intentId  │  │
│  └──────┬───────┘                └──────────────────────────┘  │
│         │                                                       │
│         │ POST /api/checkout-url or /api/subscribe              │
│         ▼                                                       │
│  ┌──────────────┐   HMAC+JWT    ┌─────────────────────────┐    │
│  │  Epochstream │ ─────────────► │  HashKey Merchant API   │    │
│  │  Backend     │               │  /merchant/orders        │    │
│  │  (Railway)   │ ◄──────────── │  /merchant/orders/       │    │
│  │              │  payment_url  │  reusable                │    │
│  └──────┬───────┘               └─────────────────────────┘    │
│         │                                                       │
│         │ User signs EIP-712 mandate in wallet                  │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │               HashKey Chain (Testnet)                    │   │
│  │         USDT Settlement Contract (ERC-20)                │   │
│  └──────┬───────────────────────────────────────────────────┘   │
│         │                                                       │
│         │ Webhook: payment-included / payment-successful         │
│         ▼                                                       │
│  ┌──────────────┐   Voucher    ┌──────────────────────────┐    │
│  │  /webhook/   │ ─────────── ► │  HMAC-validated voucher  │    │
│  │  hsp         │              │  issued to Agent A        │    │
│  └──────────────┘              └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

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

## 🏆 Hackathon

**HashKey Chain On-Chain Horizon Hackathon 2026**  
Track: **PayFi** | Prize Pool: **10,000 USDT**  
Submission Deadline: **Apr 15, 2026 23:59 GMT+8**

Built with ❤️ using HSP (HashKey Settlement Protocol)
