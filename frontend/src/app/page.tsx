"use client";

import React, { useState, useEffect, useRef } from 'react';
import {
  Bot, Server, Network, AlertTriangle, CheckCircle2,
  Loader2, Zap, Send, TrendingUp, ExternalLink, Wallet, MousePointer
} from 'lucide-react';

const API_BASE = "https://epochstream-production.up.railway.app";

// ── Types ─────────────────────────────────────────────────────────────────────
type MsgType = 'text' | 'payment-choice' | 'loading' | 'signal-card' | 'error' | 'link';
type FlowState = 'idle' | 'fetching' | 'awaiting-choice' | 'manual-pending' | 'auto-pending' | 'complete';

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
  content: 'Agent A online. I\'m connected to the Epochstream oracle network. Ask me for a HashKey trading signal.'
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function EpochstreamDashboard() {
  const [messages,       setMessages]       = useState<Message[]>([WELCOME]);
  const [settlementLogs, setSettlementLogs] = useState<LogEntry[]>([]);
  const [sellerLogs,     setSellerLogs]     = useState<LogEntry[]>([]);
  const [flowState,      setFlowState]      = useState<FlowState>('idle');
  const [input,          setInput]          = useState('');
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
  const handleSend = async () => {
    const q = input.trim();
    if (!q || flowState !== 'idle') return;
    setInput('');
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
      const res  = await fetch(`${API_BASE}/api/checkout-url`, {
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

  // ── Step 4b: Autonomous path — ethers.js lockFunds ──────────────────────────
  const handleAutonomousPay = async (intentId: string) => {
    setFlowState('auto-pending');
    addMsg({ role: 'user', type: 'text', content: 'Authorize your agent wallet to pay autonomously.' });
    addMsg({ role: 'agent', type: 'loading', content: 'Agent signing transaction autonomously via ethers.js...' });
    addSlog('Autonomous execution initiated', 'text-purple-400', '🤖');
    addSlog('Checking USDT + HSK balances...', 'text-purple-400', '💰');

    try {
      const res  = await fetch(`${API_BASE}/api/autonomous-pay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId })
      });
      const data = await res.json();
      removeLoading();

      // Insufficient funds → red warning bubble
      if (res.status === 402 || data.error) {
        addMsg({ role: 'agent', type: 'error', content: data.error });
        addSlog('Insufficient agent wallet balance', 'text-red-400', '❌');
        setFlowState('idle');
        return;
      }

      // Success — tx landed
      addSlog('USDT approved ✓', 'text-purple-400', '✍️');
      addSlog('lockFunds() executed on-chain', 'text-purple-400', '🔒');
      addSlog(`TX: ${data.txHash?.slice(0, 20)}...`, 'text-emerald-400', '⛓️');
      addElog(`← FundsLocked event on HashKey Chain`, 'text-purple-400');
      addElog(`  TX: ${data.txHash?.slice(0, 22)}...`, 'text-slate-500');

      addMsg({
        role: 'agent', type: 'link',
        content: 'Payment verified on-chain. Transaction confirmed by HashKey Chain.',
        data: { txHash: data.txHash }
      });

      await fulfillData(data.voucherId);
    } catch (_) {
      removeLoading();
      addMsg({ role: 'agent', type: 'error', content: 'Autonomous payment failed. Try manual path.' });
      setFlowState('idle');
    }
  };

  // ── Polling (manual path) ────────────────────────────────────────────────────
  const pollUntilPaid = async (intentId: string) => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res  = await fetch(`${API_BASE}/api/status?intentId=${intentId}`);
        const json = await res.json();
        if (json.status === 'LOCKED_AND_VERIFIED' && json.voucherId) {
          addSlog('Webhook received!', 'text-emerald-400', '✅');
          addSlog('HMAC validated ✓', 'text-emerald-400', '🔒');
          addSlog(`Voucher: ${json.voucherId.slice(0, 20)}...`, 'text-emerald-400', '🎫');
          addElog(`← payment-successful webhook`, 'text-emerald-400');
          addElog(`  Voucher issued`, 'text-slate-500');
          removeLoading();
          addMsg({ role: 'agent', type: 'text', content: 'Payment verified via HSP. Fetching your premium trading signal...' });
          await fulfillData(json.voucherId);
          return;
        }
      } catch (_) {}
    }
    addMsg({ role: 'agent', type: 'error', content: 'Payment verification timed out.' });
    setFlowState('idle');
  };

  // ── Final data fulfillment ───────────────────────────────────────────────────
  const fulfillData = async (voucherId: string) => {
    addElog(`→ GET /api/premium-data`, 'text-slate-400');
    addElog(`  X-HSP-Voucher-ID: ${voucherId.slice(0, 20)}...`, 'text-slate-500');
    try {
      const res  = await fetch(`${API_BASE}/api/premium-data`, {
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
                <button onClick={() => handleAutonomousPay(m.data.intentId)} disabled={flowState !== 'awaiting-choice'}
                  className="flex items-center gap-2 px-3 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/40 text-purple-300 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  <Wallet className="w-3 h-3" /> Authorize Agent Wallet
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
                <a href={`https://explorer-test.hashkey.cloud/tx/${m.data.txHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                  <ExternalLink className="w-3 h-3" /> View on HashKey Explorer
                </a>
              )}
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
                  ['Asset',              m.data.asset,            'text-white'],
                  ['Signal',             m.data.signal,           m.data.signal.startsWith('LONG') ? 'text-emerald-400 font-black text-sm' : 'text-red-400 font-black text-sm'],
                  ['Confidence',         `${m.data.confidence}%`, 'text-cyan-400'],
                  ['Whale Accumulation', m.data.whaleAccumulation,'text-amber-400'],
                  ['Price Target',       m.data.priceTarget,      'text-emerald-400'],
                  ['Stop Loss',          m.data.stopLoss,         'text-red-400'],
                  ['Risk Level',         m.data.riskLevel,        'text-slate-300'],
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
        <section className="flex flex-col bg-slate-900">
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
            <div className="flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2 border border-slate-700 focus-within:border-cyan-500/40 transition-colors">
              <input
                type="text" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                disabled={flowState !== 'idle' && flowState !== 'complete'}
                placeholder={flowState === 'idle' || flowState === 'complete' ? 'Give me a HashKey trading signal...' : 'Awaiting confirmation...'}
                className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-600 outline-none disabled:opacity-50"
              />
              <button onClick={handleSend} disabled={flowState !== 'idle' && flowState !== 'complete'} className="text-cyan-400 hover:text-cyan-300 disabled:opacity-40 transition-colors">
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
            {flowState === 'complete' && (
              <button onClick={reset} className="w-full mt-2 text-xs text-slate-600 hover:text-slate-400 transition-colors">
                ↻ Start new session
              </button>
            )}
          </div>
        </section>

        {/* ── Col 2: HSP Settlement Layer ── */}
        <section className="flex flex-col bg-slate-950">
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
        <section className="flex flex-col bg-slate-900">
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
