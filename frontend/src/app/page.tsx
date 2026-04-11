"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  Bot, Server, Network, AlertTriangle, CheckCircle2,
  Loader2, Zap, Send, TrendingUp, ExternalLink, MousePointer,
  CalendarDays, RefreshCw
} from 'lucide-react';

const API_BASE = "https://epochstream-production.up.railway.app";

// ── Types ─────────────────────────────────────────────────────────────────────
type MsgType = 'text' | 'payment-choice' | 'loading' | 'signal-card' | 'error' | 'link' | 'subscription-card';
type FlowState = 'idle' | 'fetching' | 'awaiting-choice' | 'manual-pending' | 'auto-pending' | 'sub-pending' | 'subscribed' | 'complete';

interface Message {
  id: string;
  role: 'user' | 'agent';
  type: MsgType;
  content: string;
  data?: any;
}

interface LogEntry { id: string; time: string; msg: string; color: string; icon?: string; }

const WELCOME: Message = {
  id: 'welcome', role: 'agent', type: 'text',
  content: 'Agent A online. I\'m connected to the Epochstream oracle network. Ask me for a trading signal, or subscribe for daily signals.'
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function EpochstreamDashboard() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [settlementLogs, setSettlementLogs] = useState<LogEntry[]>([]);
  const [sellerLogs, setSellerLogs] = useState<LogEntry[]>([]);
  const [flowState, setFlowState] = useState<FlowState>('idle');

  const [activeSubscriptionId, setActiveSubscriptionId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Recover state when HashKey checkout redirects back with ?success=true&intentId=xxx
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const id = p.get('intentId');
    if (p.get('success') === 'true' && id) {
      window.history.replaceState({}, '', '/');
      addMsg({ role: 'agent', type: 'loading', content: 'Verifying on-chain payment...' });
      setFlowState('manual-pending');
      pollUntilPaid(id);
    }
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
  const uid = () => crypto.randomUUID();

  const addMsg = (m: Omit<Message, 'id'>) =>
    setMessages(prev => [...prev, { ...m, id: uid() }]);

  const removeLoading = () =>
    setMessages(prev => prev.filter(m => m.type !== 'loading'));

  const addSlog = (msg: string, color = 'text-slate-400', icon = '›') =>
    setSettlementLogs(prev => [...prev, { id: uid(), time: now(), msg, color, icon }]);

  const addElog = (msg: string, color = 'text-slate-400') =>
    setSellerLogs(prev => [...prev, { id: uid(), time: now(), msg, color }]);

  // ── Step 1: User sends query ─────────────────────────────────────────────────
  const handleSend = async (q: string) => {
    if (!['idle', 'complete', 'subscribed'].includes(flowState)) return;
    addMsg({ role: 'user', type: 'text', content: q });
    setFlowState('fetching');

    await new Promise(r => setTimeout(r, 700));
    addMsg({ role: 'agent', type: 'loading', content: 'Querying Seller API for premium data...' });
    addElog('→ GET /api/premium-data (no voucher)', 'text-slate-400');

    try {
      const res = await fetch(`${API_BASE}/api/premium-data`);
      if (res.status === 402) {
        const data = await res.json();
        addElog(`← 402 Payment Required — ${data.price} ${data.currency}`, 'text-amber-400');
        addElog(`  intentId: ${data.intentId}`, 'text-slate-500');
        addSlog(`Escrow intent created`, 'text-amber-400', '🔐');
        addSlog(data.intentId.slice(0, 22) + '...', 'text-slate-500', ' ');

        removeLoading();
        addMsg({
          role: 'agent', type: 'payment-choice',
          content: `This requires premium oracle data. Cost: **${data.price} ${data.currency}**. How would you like to proceed?`,
          data: { intentId: data.intentId, price: data.price }
        });
        setFlowState('awaiting-choice');
      }
    } catch (_) {
      removeLoading();
      addMsg({ role: 'agent', type: 'error', content: 'Network error — backend unreachable.' });
      setFlowState('idle');
    }
  };

  // ── Step 4a: Manual path — generate HashKey CaaS checkout URL ───────────────
  const handleManualPay = async (intentId: string, price: number) => {
    setFlowState('manual-pending');
    addMsg({ role: 'user', type: 'text', content: "I'll pay manually via HashKey Checkout." });
    addMsg({ role: 'agent', type: 'loading', content: 'Signing ES256K JWT and generating checkout URL...' });
    addSlog('Building Cart Mandate...', 'text-cyan-400', '📝');
    addSlog('Signing with ES256K (secp256k1)...', 'text-cyan-400', '🔑');

    try {
      const res = await fetch(`${API_BASE}/api/checkout-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId, amount: price })
      });
      const data = await res.json();

      if (data.paymentUrl) {
        window.open(data.paymentUrl, '_blank');
        removeLoading();
        addSlog('Checkout URL generated!', 'text-amber-400', '🚀');
        addSlog('Awaiting EIP-712 wallet signature...', 'text-amber-400', '⏳');
        addElog('⏳ Awaiting HashKey CaaS confirmation...', 'text-amber-400');
        addMsg({
          role: 'agent', type: 'link',
          content: 'HashKey Checkout opened in a new tab. Sign the EIP-712 mandate in your wallet.',
          data: { url: data.paymentUrl }
        });
        pollUntilPaid(intentId);
      }
    } catch (_) {
      removeLoading();
      addMsg({ role: 'agent', type: 'error', content: 'Failed to generate checkout URL.' });
      setFlowState('idle');
    }
  };

  // ── Polling (manual path) ────────────────────────────────────────────────────
  const pollUntilPaid = async (intentId: string) => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`${API_BASE}/api/status?intentId=${intentId}`);
        const json = await res.json();
        if (json.status === 'LOCKED_AND_VERIFIED' && json.voucherId) {
          addSlog('Webhook received!', 'text-emerald-400', '✅');
          if (json.txHash) {
             addSlog(`TX: ${json.txHash.slice(0, 10)}...`, 'text-blue-400', '🔗');
             addMsg({ role: 'agent', type: 'link', content: 'Transaction confirmed on HashKey Testnet.', data: { url: `https://hashkey.blockscout.com/tx/${json.txHash}` } });
          }
          addSlog('HMAC validated ✓', 'text-emerald-400', '🔒');
          addSlog(`Voucher: ${json.voucherId.slice(0, 20)}...`, 'text-emerald-400', '🎫');
          addElog(`← payment-successful webhook`, 'text-emerald-400');
          addElog(`  Voucher issued`, 'text-slate-500');
          removeLoading();
          addMsg({ role: 'agent', type: 'text', content: 'Payment verified via HSP. Fetching your premium trading signal...' });
          await fulfillData(json.voucherId);
          return;
        }
      } catch (_) { }
    }
    addMsg({ role: 'agent', type: 'error', content: 'Payment verification timed out.' });
    setFlowState('idle');
  };

  // ── Final data fulfillment ───────────────────────────────────────────────────
  const fulfillData = async (voucherId: string) => {
    addElog(`→ GET /api/premium-data`, 'text-slate-400');
    addElog(`  X-HSP-Voucher-ID: ${voucherId.slice(0, 20)}...`, 'text-slate-500');
    try {
      const res = await fetch(`${API_BASE}/api/premium-data`, {
        headers: { 'X-HSP-Voucher-ID': voucherId }
      });
      if (res.ok) {
        const data = await res.json();
        addElog('← 200 OK — Premium signal served!', 'text-emerald-400');
        addSlog('M2M data fulfillment complete!', 'text-emerald-400', '🏁');
        addMsg({ role: 'agent', type: 'signal-card', content: 'Here is your premium HashKey trading signal:', data });
        setFlowState('complete');
      }
    } catch (_) {
      addMsg({ role: 'agent', type: 'error', content: 'Failed to fetch premium data.' });
      setFlowState('idle');
    }
  };

  // ── Reset ────────────────────────────────────────────────────────────────────
  const reset = () => {
    setMessages([WELCOME]);
    setSettlementLogs([]);
    setSellerLogs([]);
    setFlowState('idle');
    setActiveSubscriptionId(null);
  };

  // ── Step 4c: Subscribe — reusable mandate, daily signals ────────────────────
  const handleSubscribe = async (intentId: string, price: number) => {
    setFlowState('sub-pending');
    addMsg({ role: 'user', type: 'text', content: 'Subscribe me to daily trading signals.' });
    addMsg({ role: 'agent', type: 'loading', content: 'Creating 30-day reusable mandate via HSP...' });
    addSlog('Creating reusable mandate...', 'text-indigo-400', '📅');
    addSlog('30-day cart_expiry set', 'text-indigo-400', '⏱️');
    addSlog('Signing ES256K JWT for sub #1...', 'text-indigo-400', '🔑');

    try {
      const res = await fetch(`${API_BASE}/api/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId, amount: price })
      });
      const data = await res.json();
      if (data.paymentUrl) {
        window.open(data.paymentUrl, '_blank');
        setActiveSubscriptionId(intentId);
        removeLoading();
        addSlog('Reusable checkout URL generated!', 'text-amber-400', '🚀');
        addSlog('multi_pay=true confirmed by HSP', 'text-indigo-400', '✅');
        addElog('← 402 + POST /merchant/orders/reusable', 'text-indigo-400');
        addElog(`  cart_mandate_id: ${intentId.slice(0, 22)}...`, 'text-slate-500');
        addMsg({ role: 'agent', type: 'link', content: 'Subscription checkout opened. Authorize Day 1 payment in your wallet.', data: { url: data.paymentUrl } });
        // Poll for first charge confirmation
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const statusRes = await fetch(`${API_BASE}/api/status?intentId=${intentId}-charge1`);
          const statusJson = await statusRes.json();
          if (statusJson.status === 'LOCKED_AND_VERIFIED' && statusJson.voucherId) {
            addSlog('Charge #1 confirmed!', 'text-emerald-400', '✅');
            if (statusJson.txHash) {
              addSlog(`TX: ${statusJson.txHash.slice(0, 10)}...`, 'text-blue-400', '🔗');
              addMsg({ role: 'agent', type: 'link', content: 'Mandate activation linked on-chain.', data: { url: `https://hashkey.blockscout.com/tx/${statusJson.txHash}` } });
            }
            addSlog('Subscription ACTIVE 🟢', 'text-emerald-400', '📅');
            removeLoading();
            const signalRes = await fetch(`${API_BASE}/api/premium-data`, { headers: { 'X-HSP-Voucher-ID': statusJson.voucherId } });
            const signalData = signalRes.ok ? await signalRes.json() : null;
            addMsg({
              role: 'agent', type: 'subscription-card',
              content: 'Subscription active! Day 1 signal delivered.',
              data: { subscriptionId: intentId, chargeNumber: 1, signal: signalData, price }
            });
            setFlowState('subscribed');
            return;
          }
        }
        addMsg({ role: 'agent', type: 'error', content: 'Subscription payment timed out.' });
        setFlowState('idle');
      }
    } catch (_) {
      removeLoading();
      addMsg({ role: 'agent', type: 'error', content: 'Failed to create subscription.' });
      setFlowState('idle');
    }
  };

  // ── Next charge on existing subscription ────────────────────────────────────
  const handleNextCharge = async (subscriptionId: string, chargeNumber: number, price: number) => {
    addMsg({ role: 'agent', type: 'loading', content: `Triggering Day ${chargeNumber + 1} charge on same mandate...` });
    addSlog(`Charge #${chargeNumber + 1} initiated`, 'text-indigo-400', '🔄');
    addSlog(`Same cart_mandate_id reused`, 'text-indigo-400', '♻️');
    addSlog(`New payment_request_id generated`, 'text-indigo-400', '🔑');

    try {
      const res = await fetch(`${API_BASE}/api/subscription/charge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId, amount: price })
      });
      const data = await res.json();
      removeLoading();
      if (data.paymentUrl) {
        addSlog(`Autonomous charge #${data.chargeNumber} submitted`, 'text-amber-400', '🚀');
        addMsg({ role: 'agent', type: 'text', content: `Day ${data.chargeNumber} charge submitted securely to HSP. No wallet signature required for Reusable Mandates. Awaiting settlement...`});

        // Poll for this specific charge's confirmation
        const chargeKey = `${subscriptionId}-charge${data.chargeNumber}`;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const statusRes = await fetch(`${API_BASE}/api/status?intentId=${chargeKey}`);
          const statusJson = await statusRes.json();
          if (statusJson.status === 'LOCKED_AND_VERIFIED' && statusJson.voucherId) {
            addSlog(`Charge #${data.chargeNumber} confirmed!`, 'text-emerald-400', '✅');
            if (statusJson.txHash) {
              addSlog(`TX: ${statusJson.txHash.slice(0, 10)}...`, 'text-blue-400', '🔗');
              addMsg({ role: 'agent', type: 'link', content: `Autonomous charge executed successfully.`, data: { url: `https://hashkey.blockscout.com/tx/${statusJson.txHash}` } });
            }
            const signalRes = await fetch(`${API_BASE}/api/premium-data`, { headers: { 'X-HSP-Voucher-ID': statusJson.voucherId } });
            const signalData = signalRes.ok ? await signalRes.json() : null;
            addMsg({
              role: 'agent', type: 'subscription-card',
              content: `Day ${data.chargeNumber} payment verified! New signal delivered.`,
              data: { subscriptionId, chargeNumber: data.chargeNumber, signal: signalData, price }
            });
            return;
          }
        }
        addMsg({ role: 'agent', type: 'error', content: `Day ${data.chargeNumber} payment timed out.` });
      }
    } catch (_) {
      removeLoading();
      addMsg({ role: 'agent', type: 'error', content: 'Failed to trigger next charge.' });
    }
  };

  // ── Message renderer ─────────────────────────────────────────────────────────
  const renderMsg = (m: Message) => {
    const isUser = m.role === 'user';
    return (
      <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
        {!isUser && (
          <div className="w-6 h-6 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center mr-2 mt-1 shrink-0">
            <Bot className="w-3 h-3 text-cyan-400" />
          </div>
        )}
        <div className="max-w-[88%]">
          {m.type === 'text' && (
            <div className={`px-3 py-2 rounded-2xl text-xs leading-relaxed ${isUser ? 'bg-cyan-600 text-white rounded-tr-sm' : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-sm'}`}>
              {m.content}
            </div>
          )}
          {m.type === 'loading' && (
            <div className="px-3 py-2 rounded-2xl bg-slate-800 border border-slate-700 rounded-tl-sm flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
              {m.content}
            </div>
          )}
          {m.type === 'error' && (
            <div className="px-3 py-2.5 rounded-2xl bg-red-950/60 border border-red-500/40 rounded-tl-sm text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
              {m.content}
            </div>
          )}
          {m.type === 'payment-choice' && (
            <div className="bg-slate-800 border border-amber-500/30 rounded-2xl rounded-tl-sm p-3">
              <p className="text-xs text-slate-200 mb-3 leading-relaxed">{m.content}</p>
              <div className="flex flex-col gap-1.5">
                <button onClick={() => handleManualPay(m.data.intentId, m.data.price)} disabled={flowState !== 'awaiting-choice'}
                  className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  <MousePointer className="w-3 h-3" /> Pay Manually (HashKey Checkout)
                </button>
                <button onClick={() => handleSubscribe(m.data.intentId, m.data.price)} disabled={flowState !== 'awaiting-choice'}
                  className="flex items-center gap-2 px-3 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  <CalendarDays className="w-3 h-3" /> Subscribe — Daily Signals (Multi-Pay)
                </button>
              </div>
            </div>
          )}
          {m.type === 'link' && (
            <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-tl-sm p-3">
              <p className="text-xs text-slate-200 mb-2">{m.content}</p>
              {m.data?.url && (
                <a href={m.data.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300">
                  <ExternalLink className="w-3 h-3" /> Open HashKey Checkout
                </a>
              )}
              {m.data?.txHash && (
                <a href={`https://testnet-explorer.hsk.xyz/tx/${m.data.txHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                  <ExternalLink className="w-3 h-3" /> View on HashKey Explorer
                </a>
              )}
            </div>
          )}
          {m.type === 'subscription-card' && m.data && (
            <div className="bg-slate-800 border border-indigo-500/40 rounded-2xl rounded-tl-sm overflow-hidden shadow-[0_0_20px_rgba(99,102,241,0.08)]">
              <div className="bg-indigo-500/10 border-b border-indigo-500/20 px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="w-3.5 h-3.5 text-indigo-400" />
                  <span className="text-indigo-400 font-bold text-xs tracking-wider">DAILY SUBSCRIPTION — ACTIVE</span>
                </div>
                <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">🟢 LIVE</span>
              </div>
              <div className="p-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Plan</span>
                  <span className="text-indigo-300 font-medium">Daily HSK/USDT Oracle Signal</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Mandate Type</span>
                  <span className="text-indigo-300">Reusable (multi_pay=true)</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Billing</span>
                  <span className="text-emerald-400">${m.data.price} USDT/day</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Charges so far</span>
                  <span className="text-white font-bold">Day {m.data.chargeNumber}</span>
                </div>
                {m.data.signal && (
                  <div className="mt-2 pt-2 border-t border-slate-700">
                    <p className="text-xs text-slate-500 mb-1">Day {m.data.chargeNumber} Signal</p>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Signal</span>
                      <span className={m.data.signal.signal?.startsWith('LONG') ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{m.data.signal.signal}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Confidence</span>
                      <span className="text-cyan-400">{m.data.signal.confidence}%</span>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => handleNextCharge(m.data.subscriptionId, m.data.chargeNumber, m.data.price)}
                  className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 text-indigo-300 rounded-lg text-xs font-medium transition-all">
                  <RefreshCw className="w-3 h-3" /> Simulate Next Daily Charge
                </button>
              </div>
            </div>
          )}
          {m.type === 'signal-card' && m.data && (
            <div className="bg-slate-800 border border-emerald-500/40 rounded-2xl rounded-tl-sm overflow-hidden shadow-[0_0_20px_rgba(16,185,129,0.08)]">
              <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-bold text-xs tracking-wider">PREMIUM TRADING SIGNAL</span>
                </div>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="p-3 space-y-2">
                {[
                  ['Asset', m.data.asset, 'text-white'],
                  ['Signal', m.data.signal, m.data.signal.startsWith('LONG') ? 'text-emerald-400 font-black text-sm' : 'text-red-400 font-black text-sm'],
                  ['Confidence', `${m.data.confidence}%`, 'text-cyan-400'],
                  ['Whale Accumulation', m.data.whaleAccumulation, 'text-amber-400'],
                  ['Price Target', m.data.priceTarget, 'text-emerald-400'],
                  ['Stop Loss', m.data.stopLoss, 'text-red-400'],
                  ['Risk Level', m.data.riskLevel, 'text-slate-300'],
                ].map(([label, val, cls]) => (
                  <div key={label as string} className="flex justify-between items-center">
                    <span className="text-slate-500 text-xs">{label}</span>
                    <span className={`text-xs ${cls}`}>{val}</span>
                  </div>
                ))}
                <div className="pt-2 border-t border-slate-700">
                  <p className="text-slate-400 text-xs leading-relaxed">{m.data.analysis}</p>
                  <div className="flex justify-between mt-2 text-xs text-slate-600">
                    <span>{m.data.source}</span>
                    <span>{new Date(m.data.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {isUser && (
          <div className="w-6 h-6 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center ml-2 mt-1 shrink-0">
            <span className="text-xs text-slate-300">U</span>
          </div>
        )}
      </div>
    );
  };

  // ── Layout ───────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-slate-900 text-slate-200 font-mono flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-slate-950 border-b border-slate-800 px-5 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Zap className="text-cyan-400 w-5 h-5" />
          <h1 className="text-lg font-black tracking-widest text-white">EPOCHSTREAM<span className="text-cyan-400">.M2M</span></h1>
          <span className="text-xs text-slate-600">PayFi Hybrid Demo · HashKey Chain Testnet</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-xs text-emerald-400">LIVE</span>
        </div>
      </header>

      {/* 3-Column Grid */}
      <main className="flex-1 grid grid-cols-[40%_30%_30%] divide-x divide-slate-800 overflow-hidden">

        {/* ── Col 1: AI Quant Swarm Chat ── */}
        <section className="flex flex-col bg-slate-900 min-h-0">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
            <Bot className="w-3.5 h-3.5 text-cyan-400" />
            <h2 className="text-xs font-semibold tracking-widest text-slate-400">AI QUANT SWARM</h2>
            <span className="ml-auto text-xs text-slate-600">Agent A</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {messages.map(renderMsg)}
            <div ref={chatEndRef} />
          </div>
          <div className="border-t border-slate-800 p-3 shrink-0">
            <div className="flex flex-col gap-2 bg-slate-800 rounded-xl px-3 py-3 border border-slate-700">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Select a Data Stream:</span>
              <div className="flex flex-col gap-1.5">
                <button 
                  onClick={() => handleSend('Request Live HashKey Premium Trading Signal.')}
                  disabled={!['idle', 'complete', 'subscribed'].includes(flowState)}
                  className="text-left px-3 py-2 text-xs font-medium bg-slate-700/50 hover:bg-cyan-500/10 border border-slate-600 hover:border-cyan-500/30 text-slate-300 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ⚡ Get HashKey Oracle Trading Signal
                </button>
                <button 
                  onClick={() => handleSend('Monitor Whale Accumulation Across Major Assets.')}
                  disabled={!['idle', 'complete', 'subscribed'].includes(flowState)}
                  className="text-left px-3 py-2 text-xs font-medium bg-slate-700/50 hover:bg-cyan-500/10 border border-slate-600 hover:border-cyan-500/30 text-slate-300 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  🐋 Monitor Whale Analytics (Premium)
                </button>
              </div>
            </div>
            {flowState === 'complete' && (
              <button onClick={reset} className="w-full mt-2 text-xs text-slate-600 hover:text-slate-400 transition-colors">
                ↻ Start new session
              </button>
            )}
          </div>
        </section>

        {/* ── Col 2: HSP Settlement Layer ── */}
        <section className="flex flex-col bg-slate-950 min-h-0">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
            <Network className="w-3.5 h-3.5 text-amber-400" />
            <h2 className="text-xs font-semibold tracking-widest text-slate-400">HSP SETTLEMENT LAYER</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {settlementLogs.length === 0 && (
              <p className="text-slate-700 text-xs text-center mt-10 animate-pulse">Awaiting transaction...</p>
            )}
            {settlementLogs.map(l => (
              <div key={l.id} className="flex items-start gap-1.5 text-xs">
                <span className="shrink-0">{l.icon}</span>
                <span className="text-slate-700 shrink-0 tabular-nums">{l.time}</span>
                <span className={l.color}>{l.msg}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Col 3: Seller API Terminal ── */}
        <section className="flex flex-col bg-slate-900 min-h-0">
          <div className="px-4 py-2.5 border-b border-slate-800 flex items-center gap-2 shrink-0">
            <Server className="w-3.5 h-3.5 text-emerald-400" />
            <h2 className="text-xs font-semibold tracking-widest text-slate-400">SELLER API TERMINAL</h2>
            <span className="ml-auto text-xs text-slate-600">Agent B</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {sellerLogs.length === 0 && (
              <p className="text-slate-700 text-xs text-center mt-10 animate-pulse">No requests yet...</p>
            )}
            {sellerLogs.map(l => (
              <div key={l.id} className="flex items-start gap-1.5 text-xs">
                <span className="text-slate-700 shrink-0 tabular-nums">{l.time}</span>
                <span className={l.color}>{l.msg}</span>
              </div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}
