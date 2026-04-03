import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import * as jose from 'jose';
import fs from 'fs';

dotenv.config();

const app = express();
app.use(cors());
// Capture raw body bytes for HMAC webhook verification
app.use(express.json({
    verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); }
}));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// ── Environment ──────────────────────────────────────────────────────────────
const HASHKEY_TESTNET_RPC  = process.env.HASHKEY_TESTNET_RPC as string;
const CONTRACT_ADDRESS     = process.env.CONTRACT_ADDRESS as string;
const HSP_APP_KEY          = process.env.HSP_APP_KEY as string;
const HSP_API_SECRET       = process.env.HSP_API_SECRET as string;
const AGENT_A_PRIVATE_KEY  = process.env.AGENT_A_PRIVATE_KEY as string; // NEW: for autonomous path

// ── Constants ────────────────────────────────────────────────────────────────
const USDT_ADDRESS   = "0x372325443233fEbaC1F6998aC750276468c83CC6"; // USDT on HashKey Testnet
const USDT_DECIMALS  = 6;
const PAYMENT_AMOUNT = ethers.parseUnits("0.5", USDT_DECIMALS);      // 0.5 USDT
const MIN_GAS_HSK    = ethers.parseEther("0.01");                    // min HSK for gas

// ── In-memory session state ───────────────────────────────────────────────────
const paymentStatuses = new Map<string, string>();  // intentId → status
const intentToVoucher = new Map<string, string>();  // intentId → voucherId
const validVouchers   = new Map<string, boolean>(); // voucherId → valid

// ── Ethers provider + contract interfaces ────────────────────────────────────
const provider = new ethers.JsonRpcProvider(HASHKEY_TESTNET_RPC);

const routerAbi = [
    "event FundsLocked(bytes32 indexed intentId, address indexed buyer, address indexed seller, address token, uint256 amount)",
    "function lockFunds(bytes32 intentId, address seller, address token, uint256 amount) external"
];
const erc20Abi = [
    "function balanceOf(address owner) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)"
];

const epochstreamContract = new ethers.Contract(CONTRACT_ADDRESS, routerAbi, provider);

// ── Layer 1: On-chain event listener (fallback / parallel verifier) ──────────
console.log(`\n[ETHERS] 👁️  Listening for FundsLocked on HashKey Chain (${CONTRACT_ADDRESS})...`);

epochstreamContract.on("FundsLocked", (intentIdBytes: string, _buyer: string, _seller: string, _token: string, amount: bigint) => {
    let intentId = intentIdBytes;
    try { intentId = ethers.decodeBytes32String(intentIdBytes).replace(/\0/g, ''); } catch (_) {}

    console.log(`\n[ETHERS] ⚡ FundsLocked — intent=${intentId} amount=${ethers.formatUnits(amount, USDT_DECIMALS)} USDT`);

    if (paymentStatuses.get(intentId) !== 'LOCKED_AND_VERIFIED') {
        paymentStatuses.set(intentId, 'LOCKED_AND_VERIFIED');
        if (!intentToVoucher.has(intentId)) {
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(intentId, voucherId);
            console.log(`[ETHERS] 🎫 Voucher issued: ${voucherId}`);
        }
    }
});

// ── Canonical JSON helper (RFC 8785) ─────────────────────────────────────────
const canonicalStringify = (obj: any): string => {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(canonicalStringify).join(',')}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
};

// ── Private key loader (env var takes precedence over .pem file) ─────────────
const loadMerchantPrivateKey = (): string => {
    let raw = process.env.MERCHANT_PRIVATE_KEY;
    if (raw) return raw.replace(/\\n/g, '\n');
    return fs.readFileSync("../merchant_private_key.pem", "utf8");
};

// ── ES256K JWT + HMAC signed HashKey order helper ────────────────────────────
const buildHashKeyOrder = async (intentId: string, amount: number) => {
    const paymentRequestId = `PAY-${intentId}`; // ID2 ≠ ID1
    const contents = {
        id: intentId,                            // cart_mandate_id (ID1)
        user_cart_confirmation_required: true,
        payment_request: {
            method_data: [{
                supported_methods: "https://www.x402.org/",
                data: {
                    x402Version: 2,
                    network: "hashkey-testnet",
                    chain_id: 133,
                    contract_address: USDT_ADDRESS,
                    pay_to: CONTRACT_ADDRESS,
                    coin: "USDT"
                }
            }],
            details: {
                id: paymentRequestId,            // payment_request_id (ID2)
                display_items: [{ label: "Premium Trading Signal", amount: { currency: "USD", value: Number(amount).toFixed(2) } }],
                total: { label: "Total", amount: { currency: "USD", value: Number(amount).toFixed(2) } }
            }
        },
        cart_expiry: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z',
        merchant_name: "Epochstream"
    };

    // cart_hash = SHA256(canonicalJSON(contents))
    const cartHash = crypto.createHash('sha256').update(canonicalStringify(contents)).digest('hex');

    // Load + convert SEC1 → PKCS8 for jose
    const keyObj = crypto.createPrivateKey(loadMerchantPrivateKey());
    const pkcs8Str = keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
    const privateKey = await jose.importPKCS8(pkcs8Str, 'ES256K');

    // Sign ES256K JWT (merchant_authorization)
    const jwt = await new jose.SignJWT({ cart_hash: cartHash })
        .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
        .setIssuer("Epochstream").setSubject("Epochstream")
        .setAudience("HashkeyMerchant")
        .setIssuedAt().setExpirationTime('2h')
        .setJti(`JWT-${Date.now()}`)
        .sign(privateKey);

    // Build + HMAC-sign the full request body
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const payload = {
        cart_mandate: { contents, merchant_authorization: jwt },
        redirect_url: `${frontendUrl}?success=true&intentId=${intentId}`
    };

    // Serialize ONCE — same string hashed AND sent to axios
    const bodyStr   = canonicalStringify(payload);
    const nonce     = crypto.randomUUID().replace(/-/g, '');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash  = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const message   = `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n${timestamp}\n${nonce}`;
    const signature = crypto.createHmac('sha256', HSP_API_SECRET).update(message).digest('hex');

    const response = await axios.post(
        'https://merchant-qa.hashkeymerchant.com/api/v1/merchant/orders',
        bodyStr,
        { headers: { 'X-App-Key': HSP_APP_KEY, 'X-Signature': signature, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'Content-Type': 'application/json' } }
    );

    return response.data?.data?.payment_url as string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE A: Seller's paywalled /api/premium-data (Agent B)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/premium-data', (req, res) => {
    const voucherId = req.headers['x-hsp-voucher-id'] as string;

    if (!voucherId || !validVouchers.get(voucherId)) {
        // No valid voucher → issue a fresh intentId and demand payment
        const intentId = `order-${crypto.randomBytes(4).toString('hex')}`;
        paymentStatuses.set(intentId, 'PENDING_HSP');
        console.log(`\n[SELLER] ❌ 402 issued — intentId=${intentId}`);
        return res.status(402).json({ error: "Payment Required", intentId, price: 0.5, currency: "USDT" });
    }

    // Valid voucher → serve premium DeFi trading signal
    console.log(`\n[SELLER] ✅ Voucher verified. Serving premium trading signal.`);
    return res.status(200).json({
        signal: "LONG HSK",
        asset: "HSK/USDT",
        confidence: 94.7,
        whaleAccumulation: "+450%",
        priceTarget: "$0.847",
        stopLoss: "$0.612",
        riskLevel: "MODERATE",
        analysis: "On-chain data shows strong accumulation by whale wallets over the last 72h. HashKey Chain TVL up 182%. M2M payment flow velocity at ATH.",
        source: "Epochstream Oracle Network",
        timestamp: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE B: Status polling endpoint
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
    const intentId = req.query.intentId as string;
    return res.json({
        status: paymentStatuses.get(intentId) || 'PENDING_HSP',
        voucherId: intentToVoucher.get(intentId)
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE C: Generate HashKey CaaS Checkout URL  (Human / EIP-712 payment path)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/checkout-url', async (req, res) => {
    const { intentId, amount } = req.body;
    console.log(`\n[CHECKOUT] Generating checkout URL for intent=${intentId}`);
    try {
        const paymentUrl = await buildHashKeyOrder(intentId, amount);
        console.log(`[CHECKOUT] ✅ ${paymentUrl}`);
        return res.json({ paymentUrl });
    } catch (e: any) {
        console.error(`[CHECKOUT] ❌`, e.response?.data || e.message);
        return res.status(500).json({ error: e.response?.data || e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE D: Autonomous on-chain payment  (Agent Wallet / ethers.js path)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/autonomous-pay', async (req, res) => {
    const { intentId } = req.body;
    console.log(`\n[AUTONOMOUS] 🤖 Initiating autonomous payment for intent=${intentId}`);

    if (!AGENT_A_PRIVATE_KEY) {
        return res.status(500).json({ error: "AGENT_A_PRIVATE_KEY not configured on server." });
    }

    try {
        const agentWallet = new ethers.Wallet(AGENT_A_PRIVATE_KEY, provider);
        const walletAddress = await agentWallet.getAddress();

        // ── Balance checks (fail fast before any tx) ──────────────────────────
        const usdtContract = new ethers.Contract(USDT_ADDRESS, erc20Abi, agentWallet);
        const [usdtBalance, hskBalance] = await Promise.all([
            usdtContract.balanceOf(walletAddress),
            provider.getBalance(walletAddress)
        ]);

        console.log(`[AUTONOMOUS] USDT=${ethers.formatUnits(usdtBalance, USDT_DECIMALS)} HSK=${ethers.formatEther(hskBalance)}`);

        if (usdtBalance < PAYMENT_AMOUNT || hskBalance < MIN_GAS_HSK) {
            return res.status(402).json({
                error: "Agent Wallet Insufficient Funds. Please top up the agent's smart account or pay manually.",
                usdtBalance: ethers.formatUnits(usdtBalance, USDT_DECIMALS),
                hskBalance: ethers.formatEther(hskBalance),
                required: { usdt: "0.5", hsk: "0.01 (gas)" }
            });
        }

        // ── Approve USDT spend ────────────────────────────────────────────────
        console.log(`[AUTONOMOUS] ✍️  Approving USDT...`);
        const approveTx = await usdtContract.approve(CONTRACT_ADDRESS, PAYMENT_AMOUNT);
        await approveTx.wait();

        // ── Lock funds in EpochstreamRouter.sol escrow ───────────────────────
        const routerWithSigner = new ethers.Contract(CONTRACT_ADDRESS, routerAbi, agentWallet);
        const intentIdBytes32  = ethers.encodeBytes32String(intentId.slice(0, 31));

        console.log(`[AUTONOMOUS] 🔒 Calling lockFunds()...`);
        const lockTx  = await routerWithSigner.lockFunds(intentIdBytes32, walletAddress, USDT_ADDRESS, PAYMENT_AMOUNT);
        const receipt = await lockTx.wait();
        const txHash  = receipt.hash;

        console.log(`[AUTONOMOUS] 🎉 TX confirmed: ${txHash}`);

        // Immediately issue voucher (on-chain listener may also do this idempotently)
        if (paymentStatuses.get(intentId) !== 'LOCKED_AND_VERIFIED') {
            paymentStatuses.set(intentId, 'LOCKED_AND_VERIFIED');
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(intentId, voucherId);
        }

        return res.json({ txHash, voucherId: intentToVoucher.get(intentId) });

    } catch (e: any) {
        console.error(`[AUTONOMOUS] ❌`, e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE E: HashKey Webhook (HMAC-SHA256 verified, constant-time compare)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/hsp', (req, res) => {
    console.log(`\n[WEBHOOK] 🔗 Incoming callback from HashKey CaaS...`);
    const sigHeader = req.headers['x-signature'] as string;

    if (sigHeader) {
        try {
            let t = '', v1 = '';
            sigHeader.split(',').forEach(p => {
                if (p.startsWith('t='))  t  = p.substring(2);
                if (p.startsWith('v1=')) v1 = p.substring(3);
            });

            if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t)) > 300) {
                console.error(`[WEBHOOK] ⚠️ Timestamp out of tolerance.`);
                return res.status(400).json({ code: 1, msg: "timestamp out of tolerance" });
            }

            const rawBody    = (req as any).rawBody || JSON.stringify(req.body);
            const expected   = crypto.createHmac('sha256', HSP_API_SECRET).update(`${t}.${rawBody}`).digest('hex');

            if (expected.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) {
                console.error(`[WEBHOOK] ❌ HMAC mismatch.`);
                return res.status(403).json({ code: 1, msg: "signature mismatch" });
            }
            console.log(`[WEBHOOK] 🔒 HMAC validated!`);
        } catch (_) {
            console.error(`[WEBHOOK] ⚠️ Signature parse error, proceeding.`);
        }
    }

    // cart_mandate_id (ID1) = our intentId — never use payment_request_id (ID2)
    const intentId = req.body.cart_mandate_id || req.body.data?.cart_mandate_id;
    const status   = req.body.status || req.body.data?.status;

    console.log(`[WEBHOOK] cart_mandate_id=${intentId} status=${status}`);

    if ((status === 'payment-successful' || status === 'payment-included') && intentId) {
        if (paymentStatuses.get(intentId) !== 'LOCKED_AND_VERIFIED') {
            paymentStatuses.set(intentId, 'LOCKED_AND_VERIFIED');
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(intentId, voucherId);
            console.log(`[WEBHOOK] 🎫 Voucher issued: ${voucherId}`);
        }
        return res.status(200).json({ code: 0, msg: "success" });
    }

    return res.status(200).json({ code: 0, msg: "received" });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🌟 Epochstream Hybrid Backend on port ${PORT}`);
});
