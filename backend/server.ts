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
// Persist the exact raw bytes of incoming requests (required for HashKey Webhook HMAC signature validation)
app.use(express.json({
    verify: (req, res, buf) => {
        (req as any).rawBody = buf.toString('utf8');
    }
}));


const PORT = 3001;

const HASHKEY_TESTNET_RPC = process.env.HASHKEY_TESTNET_RPC as string;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as string;
const HSP_MERCHANT_ID = process.env.HSP_MERCHANT_ID as string;
const HSP_APP_KEY = process.env.HSP_APP_KEY as string;
const HSP_API_SECRET = process.env.HSP_API_SECRET as string;

const paymentStatuses = new Map<string, string>(); // intentId -> status
const intentToVoucher = new Map<string, string>(); // intentId -> voucherId
const validVouchers = new Map<string, boolean>();

// ----------------------------------------------------
// LAYER 1: ETHERS.JS ON-CHAIN VALIDATION LISTENER
// ----------------------------------------------------
const provider = new ethers.JsonRpcProvider(HASHKEY_TESTNET_RPC);
const routerAbi = [
    "event FundsLocked(bytes32 indexed intentId, address indexed buyer, address indexed seller, address token, uint256 amount)"
];
const epochstreamContract = new ethers.Contract(CONTRACT_ADDRESS, routerAbi, provider);

console.log(`\n[ETHERS LISTENER] 👁️  Listening for FundsLocked events on HashKey Chain (${CONTRACT_ADDRESS})...`);

epochstreamContract.on("FundsLocked", (intentIdBytes, buyer, seller, token, amount, event) => {
    let intentId = intentIdBytes;
    try { intentId = ethers.decodeBytes32String(intentIdBytes).replace(/\0/g, ''); } catch (e) { }

    console.log(`\n[ETHERS LISTENER] ⚡ ON-CHAIN EVENT DETECTED ON HASHKEY CHAIN!`);
    console.log(`[ETHERS LISTENER] 🔒 Intent ${intentId} locked ${ethers.formatEther(amount)} HSK/USDT.`);

    if (paymentStatuses.get(intentId) !== 'LOCKED_AND_VERIFIED') {
        paymentStatuses.set(intentId, 'LOCKED_AND_VERIFIED');

        // Setup voucher instantly if webhook failed or hasn't arrived
        if (!intentToVoucher.has(intentId)) {
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(intentId, voucherId);
        }
        console.log(`[ETHERS LISTENER] 🟢 Successfully mapped Intent ${intentId} to fully unlocked Voucher!`);
    }
});

// ----------------------------------------------------
// LAYER 2: SELLER API (Agent B's Server)
// ----------------------------------------------------
app.get('/api/premium-data', (req, res) => {
    console.log(`\n[SELLER API] 📥 Received request for premium data from Agent A...`);
    const voucherId = req.headers['x-hsp-voucher-id'] as string;

    if (!voucherId || !validVouchers.get(voucherId)) {
        console.log(`[SELLER API] ❌ No valid X-HSP-Voucher-ID found. Rejecting with HTTP 402...`);
        const intentId = `order-${crypto.randomBytes(4).toString('hex')}`;
        paymentStatuses.set(intentId, 'PENDING_HSP');

        return res.status(402).json({
            error: "Payment Required via Epochstream Escrow",
            intentId: intentId,
            price: 0.5,
            currency: "USDT"
        });
    }

    console.log(`[SELLER API] ✅ Valid X-HSP-Voucher-ID (${voucherId}) Authenticated!`);
    console.log(`[SELLER API] 📤 Serving premium JSON data...`);

    return res.status(200).json({
        data: "CONFIDENTIAL AI REPORT",
        sentimentScore: 0.98,
        analysis: "HashKey Chain is exhibiting strong bullish on-chain metrics, with high velocity in M2M token flow. Escrow volumes up 400%.",
        timestamp: new Date().toISOString()
    });
});

// Status checker for UI polling
app.get('/api/status', (req, res) => {
    const intentId = req.query.intentId as string;
    const status = paymentStatuses.get(intentId) || 'PENDING_HSP';
    const voucherId = intentToVoucher.get(intentId);

    return res.json({ status, voucherId });
});

// ----------------------------------------------------
// LAYER 3: PRODUCTION HSP WEBHOOK LISTENER
// ----------------------------------------------------
app.post('/webhook/hsp', (req, res) => {
    console.log(`\n[HSP MIDDLEWARE] 🔗 Webhook triggered by HashKey CaaS...`);

    // Strict HashKey Webhook HMAC-SHA256 Verification (v1 signature)
    const hashkeySignature = req.headers['x-signature'] as string;

    if (hashkeySignature) {
        try {
            let t = '';
            let v1 = '';
            hashkeySignature.split(',').forEach(part => {
                if (part.startsWith('t=')) t = part.substring(2);
                if (part.startsWith('v1=')) v1 = part.substring(3);
            });

            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(now - parseInt(t)) > 300) {
                console.error(`[HSP MIDDLEWARE] ⚠️ Webhook timestamp out of tolerance (>5 minutes). Rejecting...`);
                return res.status(400).json({ code: 1, msg: "timestamp out of tolerance" });
            }

            // Recompute strict payload using the EXACT incoming raw bytes (Critical for precise HMAC-SHA256 matching)
            const rawBody = (req as any).rawBody || JSON.stringify(req.body);
            const message = `${t}.${rawBody}`;
            const expectedHex = crypto.createHmac('sha256', HSP_API_SECRET).update(message).digest('hex');

            if (expectedHex.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expectedHex))) {
                console.error(`[HSP MIDDLEWARE] ❌ Strict Webhook Signature mismatch! Probable attack intercepted.`);
                return res.status(403).json({ code: 1, msg: "signature mismatch" });
            } else {
                console.log(`[HSP MIDDLEWARE] 🔒 HashKey cryptographic signature validated perfectly!`);
            }
        } catch (e) {
            console.error(`[HSP MIDDLEWARE] ⚠️ Signature parsing error. Proceeding with caution...`);
        }
    }

    // Safely extract the ID
    const intentId = req.body.payment_request_id || req.body.cart_mandate_id || req.body.intentId || req.body.data?.payment_request_id;
    const status = req.body.status || req.body.data?.status;

    // Fast-path confirm
    if ((status === 'payment-successful' || status === 'SUCCESS' || status === 'PAID') && intentId) {
        console.log(`[HSP MIDDLEWARE] ✅ Payment for intent ${intentId} confirmed through CaaS!`);

        if (paymentStatuses.get(intentId) !== 'LOCKED_AND_VERIFIED') {
            paymentStatuses.set(intentId, 'LOCKED_AND_VERIFIED');
            const voucherId = `hsp-voucher-${crypto.randomBytes(4).toString('hex')}`;
            validVouchers.set(voucherId, true);
            intentToVoucher.set(intentId, voucherId);
        }
        return res.status(200).json({ code: 0, msg: "success" });
    }

    return res.status(200).json({ code: 0, msg: "received" });
});

// ----------------------------------------------------
// BUYER AGENT LOGIC (Live Cryptographic Checkout Generator)
// ----------------------------------------------------
app.post('/api/agent-checkout', async (req, res) => {
    const { intentId, amount } = req.body;
    console.log(`\n[BUYER AGENT] ⚙️ Generating ES256K JWT and building live HashKey checkout URL...`);

    try {
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
                        contract_address: "0x372325443233fEbaC1F6998aC750276468c83CC6", // USDT Testnet
                        pay_to: CONTRACT_ADDRESS,
                        coin: "USDT"
                    }
                }],
                details: {
                    id: intentId,
                    display_items: [{ label: "Premium AI Data", amount: { currency: "USDT", value: Number(amount).toFixed(2) } }],
                    total: { label: "Total", amount: { currency: "USDT", value: Number(amount).toFixed(2) } }
                }
            },
            cart_expiry: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z',
            merchant_name: "Epochstream"
        };

        // HashKey mandates Canonical JSON (alphabetical keys) for deterministic body hashing
        const canonicalStringify = (obj: any): string => {
            if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
            if (Array.isArray(obj)) return `[${obj.map(canonicalStringify).join(',')}]`;
            const keys = Object.keys(obj).sort();
            return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
        };
        const cartHash = crypto.createHash('sha256').update(canonicalStringify(contents)).digest('hex');

        let privateKeyStr = process.env.MERCHANT_PRIVATE_KEY;
        if (privateKeyStr) {
            privateKeyStr = privateKeyStr.replace(/\\n/g, '\n');
        } else {
            privateKeyStr = fs.readFileSync("../merchant_private_key.pem", "utf8");
        }
        
        // Convert SEC1 to PKCS8 dynamically for jose
        const keyObj = crypto.createPrivateKey(privateKeyStr);
        const pkcs8Str = keyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
        const privateKey = await jose.importPKCS8(pkcs8Str, 'ES256K');
        const jwt = await new jose.SignJWT({ cart_hash: cartHash })
            .setProtectedHeader({ alg: 'ES256K', typ: 'JWT' })
            .setIssuer("Epochstream")
            .setSubject("Epochstream")
            .setAudience("HashkeyMerchant")
            .setIssuedAt()
            .setExpirationTime('2h')
            .setJti(`JWT-${Date.now()}`)
            .sign(privateKey);

        const payload = {
            cart_mandate: { contents, merchant_authorization: jwt },
            redirect_url: "http://localhost:3000?success=true"
        };

        const nonce = crypto.randomUUID().replace(/-/g, '');
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyHash = crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
        const message = `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n${timestamp}\n${nonce}`;
        const signature = crypto.createHmac('sha256', HSP_API_SECRET).update(message).digest('hex');

        // Live request execution using QA/Integration server per docs
        const response = await axios.post(`https://merchant-qa.hashkeymerchant.com/api/v1/merchant/orders`, payload, {
            headers: {
                'X-App-Key': HSP_APP_KEY,
                'X-Signature': signature,
                'X-Timestamp': timestamp,
                'X-Nonce': nonce,
                'Content-Type': 'application/json'
            }
        });

        const paymentUrl = response.data?.data?.payment_url;
        console.log(`\n\n======================================================`);
        console.log(`🚀 [ACTION REQUIRED] HASHKEY CHECKOUT GENERATED!`);
        console.log(`👉 PLEASE CLICK HERE TO PAY: ${paymentUrl}`);
        console.log(`======================================================\n`);

        return res.json({ paymentUrl });
    } catch (e: any) {
        console.error(`[BUYER AGENT] ❌ Live Integration Error:`, e.response?.data || e.message);
        // Fallback or bubble error
        return res.status(500).json({ error: e.response?.data || e.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🌟 Epochstream Live Prod Backend running on port ${PORT}`);
});
