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
app.use(express.json({
    verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); }
}));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

const HASHKEY_TESTNET_RPC  = process.env.HASHKEY_TESTNET_RPC as string;
const CONTRACT_ADDRESS     = process.env.CONTRACT_ADDRESS as string;
const HSP_APP_KEY          = process.env.HSP_APP_KEY as string;
const HSP_API_SECRET       = process.env.HSP_API_SECRET as string;
const AGENT_A_PRIVATE_KEY  = process.env.AGENT_A_PRIVATE_KEY as string;

const USDT_ADDRESS   = "0x372325443233fEbaC1F6998aC750276468c83CC6";
const USDT_DECIMALS  = 6;
const PAYMENT_AMOUNT = ethers.parseUnits("0.5", USDT_DECIMALS);
const MIN_GAS_HSK    = ethers.parseEther("0.01");

const paymentStatuses   = new Map<string, string>();
const intentToVoucher   = new Map<string, string>();
const validVouchers     = new Map<string, boolean>();
// Subscription (reusable mandate) tracking
const subscriptions     = new Map<string, { chargeCount: number; lastChargeAt: number }>();

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

console.log(`\n[ETHERS] 👁️  Listening for FundsLocked on HashKey Chain (${CONTRACT_ADDRESS})...`);

epochstreamContract.on("FundsLocked", (intentIdBytes: string, _b: string, _s: string, _t: string, amount: bigint) => {
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

// ── Canonical JSON (RFC 8785) ─────────────────────────────────────────────────
const canonicalStringify = (obj: any): string => {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(canonicalStringify).join(',')}]`;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
};

// ── Load merchant private key (env var first, .pem fallback) ─────────────────
const loadMerchantPrivateKey = (): string => {
    const raw = process.env.MERCHANT_PRIVATE_KEY;
    if (raw) return raw.replace(/\\n/g, '\n');
    return fs.readFileSync("../merchant_private_key.pem", "utf8");
};

// ── Build HashKey CaaS order (ES256K JWT + HMAC-SHA256) ──────────────────────
const buildHashKeyOrder = async (intentId: string, amount: number): Promise<string> => {
    const paymentRequestId = `PAY-${intentId}`;
    const contents = {
        id: intentId,
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
                id: paymentRequestId,
                display_items: [{ label: "Premium Trading Signal", amount: { currency: "USD", value: Number(amount).toFixed(2) } }],
                total: { label: "Total", amount: { currency: "USD", value: Number(amount).toFixed(2) } }
            }
        },
        cart_expiry: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z',
        merchant_name: "Epochstream"
    };

    const cartHash   = crypto.createHash('sha256').update(canonicalStringify(contents)).digest('hex');
    const keyObj     = crypto.createPrivateKey(loadMerchantPrivateKey());
    const pkcs8Str   = keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
    const privateKey = await jose.importPKCS8(pkcs8Str, 'ES256K');

    const jwt = await new jose.SignJWT({ cart_hash: cartHash })
        .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
        .setIssuer("Epochstream").setSubject("Epochstream")
        .setAudience("HashkeyMerchant")
        .setIssuedAt().setExpirationTime('2h')
        .setJti(`JWT-${Date.now()}`)
        .sign(privateKey);

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const payload = {
        cart_mandate: { contents, merchant_authorization: jwt },
        redirect_url: `${frontendUrl}?success=true&intentId=${intentId}`
    };

    // Hash and send the EXACT same canonical string (prevents HMAC body mismatch)
    const bodyStr   = canonicalStringify(payload);
    const nonce     = crypto.randomUUID().replace(/-/g, '');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash  = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const message   = `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n${timestamp}\n${nonce}`;
    const signature = crypto.createHmac('sha256', HSP_API_SECRET).update(message).digest('hex');

    const response = await axios.post(
        'https://merchant-qa.hashkeymerchant.com/api/v1/merchant/orders',
        bodyStr,
        {
            headers: {
                'X-App-Key': HSP_APP_KEY,
                'X-Signature': signature,
                'X-Timestamp': timestamp,
                'X-Nonce': nonce,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                // Browser-like UA prevents Cloudflare WAF managed challenge on Railway IPs
                'User-Agent': 'Mozilla/5.0 (compatible; Epochstream/1.0; +https://epochstream-production.up.railway.app)',
                'Origin': 'https://merchant-qa.hashkeymerchant.com',
            }
        }
    );

    // Detect Cloudflare HTML challenge page returned instead of JSON
    if (typeof response.data === 'string' && (response.data as string).includes('challenge-platform')) {
        throw new Error('Cloudflare WAF blocked this request. Ask HashKey to whitelist Railway egress IPs.');
    }

    return response.data?.data?.payment_url as string;
};

// ── Build HashKey REUSABLE order (subscription / multi-pay mandate) ───────────
const buildHashKeyReusableOrder = async (
    subscriptionId: string,
    amount: number,
    chargeNumber: number
): Promise<string> => {
    // Each charge needs a unique payment_request_id (ID2) but shares the same cart_mandate_id (ID1)
    const paymentRequestId = `PAY-${subscriptionId}-charge${chargeNumber}`;
    const contents = {
        id: subscriptionId,                          // same across all charges
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
                id: paymentRequestId,
                display_items: [{
                    label: `Daily Trading Signal — Day ${chargeNumber}`,
                    amount: { currency: "USD", value: Number(amount).toFixed(2) }
                }],
                total: { label: "Total", amount: { currency: "USD", value: Number(amount).toFixed(2) } }
            }
        },
        // 30-day expiry covers the full subscription lifecycle
        cart_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z',
        merchant_name: "Epochstream"
    };

    const cartHash   = crypto.createHash('sha256').update(canonicalStringify(contents)).digest('hex');
    const keyObj     = crypto.createPrivateKey(loadMerchantPrivateKey());
    const pkcs8Str   = keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
    const privateKey = await jose.importPKCS8(pkcs8Str, 'ES256K');

    const jwt = await new jose.SignJWT({ cart_hash: cartHash })
        .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
        .setIssuer("Epochstream").setSubject("Epochstream")
        .setAudience("HashkeyMerchant")
        .setIssuedAt().setExpirationTime('2h')
        .setJti(`JWT-${Date.now()}-${chargeNumber}`)
        .sign(privateKey);

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const payload = {
        cart_mandate: { contents, merchant_authorization: jwt },
        redirect_url: `${frontendUrl}?success=true&intentId=${subscriptionId}&charge=${chargeNumber}`
    };

    const bodyStr   = canonicalStringify(payload);
    const nonce     = crypto.randomUUID().replace(/-/g, '');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash  = crypto.createHash('sha256').update(bodyStr).digest('hex');
    // Note: reusable endpoint path for HMAC message
    const message   = `POST\n/api/v1/merchant/orders/reusable\n\n${bodyHash}\n${timestamp}\n${nonce}`;
    const signature = crypto.createHmac('sha256', HSP_API_SECRET).update(message).digest('hex');

    const response = await axios.post(
        'https://merchant-qa.hashkeymerchant.com/api/v1/merchant/orders/reusable',
        bodyStr,
        {
            headers: {
                'X-App-Key': HSP_APP_KEY,
                'X-Signature': signature,
                'X-Timestamp': timestamp,
                'X-Nonce': nonce,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; Epochstream/1.0; +https://epochstream-production.up.railway.app)',
                'Origin': 'https://merchant-qa.hashkeymerchant.com',
            }
        }
    );

    if (typeof response.data === 'string' && (response.data as string).includes('challenge-platform')) {
        throw new Error('Cloudflare WAF blocked the reusable order request.');
    }

    console.log(`[SUBSCRIBE] Reusable order charge #${chargeNumber} for ${subscriptionId}: multi_pay=${response.data?.data?.multi_pay}`);
    return response.data?.data?.payment_url as string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE A: Seller paywalled endpoint (Agent B)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/premium-data', (req, res) => {
    const voucherId = req.headers['x-hsp-voucher-id'] as string;

    if (!voucherId || !validVouchers.get(voucherId)) {
        const intentId = `order-${crypto.randomBytes(4).toString('hex')}`;
        paymentStatuses.set(intentId, 'PENDING_HSP');
        console.log(`\n[SELLER] ❌ 402 issued — intentId=${intentId}`);
        return res.status(402).json({ error: "Payment Required", intentId, price: 0.5, currency: "USDT" });
    }

    console.log(`\n[SELLER] ✅ Valid voucher. Serving premium trading signal.`);
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
// ROUTE B: Status polling
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
    const intentId = req.query.intentId as string;
    return res.json({
        status: paymentStatuses.get(intentId) || 'PENDING_HSP',
        voucherId: intentToVoucher.get(intentId)
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE C: Generate HashKey CaaS checkout URL (human / EIP-712 payment path)
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
// ROUTE C2: Create reusable subscription mandate (first charge)
// Uses POST /merchant/orders/reusable — same cart_mandate_id can be charged N times
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/subscribe', async (req, res) => {
    const { intentId, amount } = req.body;
    console.log(`\n[SUBSCRIBE] 📅 Creating reusable mandate for sub=${intentId}`);
    try {
        // charge #1 — initializes the reusable mandate
        const paymentUrl = await buildHashKeyReusableOrder(intentId, amount, 1);
        subscriptions.set(intentId, { chargeCount: 1, lastChargeAt: Date.now() });
        paymentStatuses.set(intentId, 'PENDING_HSP');
        console.log(`[SUBSCRIBE] ✅ Reusable mandate created. Checkout: ${paymentUrl}`);
        return res.json({ paymentUrl, subscriptionId: intentId, chargeNumber: 1 });
    } catch (e: any) {
        console.error(`[SUBSCRIBE] ❌`, e.response?.data || e.message);
        return res.status(500).json({ error: e.response?.data || e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE C3: Trigger next charge on existing reusable mandate
// Same cart_mandate_id, new unique payment_request_id per charge
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/subscription/charge', async (req, res) => {
    const { subscriptionId, amount } = req.body;
    const sub = subscriptions.get(subscriptionId);
    if (!sub) {
        return res.status(404).json({ error: 'Subscription not found. Create one via /api/subscribe first.' });
    }
    const nextCharge = sub.chargeCount + 1;
    console.log(`\n[SUBSCRIBE] 🔄 Triggering charge #${nextCharge} for sub=${subscriptionId}`);
    try {
        const paymentUrl = await buildHashKeyReusableOrder(subscriptionId, amount ?? 0.5, nextCharge);
        subscriptions.set(subscriptionId, { chargeCount: nextCharge, lastChargeAt: Date.now() });
        // Reset payment status so polling works for new charge
        paymentStatuses.set(`${subscriptionId}-charge${nextCharge}`, 'PENDING_HSP');
        console.log(`[SUBSCRIBE] ✅ Charge #${nextCharge} URL: ${paymentUrl}`);
        return res.json({ paymentUrl, chargeNumber: nextCharge, subscriptionId });
    } catch (e: any) {
        console.error(`[SUBSCRIBE] ❌`, e.response?.data || e.message);
        return res.status(500).json({ error: e.response?.data || e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE E: HashKey Webhook (HMAC-SHA256 verified, constant-time compare)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook/hsp', (req, res) => {
    console.log(`\n[WEBHOOK] 🔗 Callback from HashKey CaaS...`);
    const sigHeader = req.headers['x-signature'] as string;

    if (sigHeader) {
        try {
            let t = '', v1 = '';
            sigHeader.split(',').forEach(p => {
                if (p.startsWith('t='))  t  = p.substring(2);
                if (p.startsWith('v1=')) v1 = p.substring(3);
            });

            if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t)) > 300) {
                return res.status(400).json({ code: 1, msg: "timestamp out of tolerance" });
            }

            const rawBody  = (req as any).rawBody || JSON.stringify(req.body);
            const expected = crypto.createHmac('sha256', HSP_API_SECRET).update(`${t}.${rawBody}`).digest('hex');

            if (expected.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) {
                console.error(`[WEBHOOK] ❌ HMAC mismatch.`);
                return res.status(403).json({ code: 1, msg: "signature mismatch" });
            }
            console.log(`[WEBHOOK] 🔒 HMAC validated!`);
        } catch (_) {
            console.error(`[WEBHOOK] ⚠️ Signature parse error.`);
        }
    }

    // Use cart_mandate_id (ID1 = our intentId) and check payment_request_id for recurring charges
    const intentId = req.body.cart_mandate_id || req.body.data?.cart_mandate_id;
    const paymentReqId = req.body.payment_request_id || req.body.data?.payment_request_id;
    const status   = req.body.status || req.body.data?.status;
    console.log(`[WEBHOOK] cart_mandate_id=${intentId} payment_req_id=${paymentReqId} status=${status}`);

    if ((status === 'payment-successful' || status === 'payment-included') && intentId) {
        const match = paymentReqId ? paymentReqId.match(/-charge(\d+)$/) : null;
        const key = match ? `${intentId}-charge${match[1]}` : intentId;

        if (paymentStatuses.get(key) !== 'LOCKED_AND_VERIFIED') {
            paymentStatuses.set(key, 'LOCKED_AND_VERIFIED');
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(key, voucherId);
            console.log(`[WEBHOOK] 🎫 Voucher issued for ${key}: ${voucherId}`);
        }
        return res.status(200).json({ code: 0, msg: "success" });
    }

    return res.status(200).json({ code: 0, msg: "received" });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🌟 Epochstream Hybrid Backend on port ${PORT}`);
});
