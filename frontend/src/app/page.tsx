"use client";

import React, { useState } from 'react';
import {
  Bot, Server, Network, ShieldAlert,
  CheckCircle2, Loader2, Key, Zap
} from 'lucide-react';

const API_BASE = "http://localhost:3001";

export default function EpochstreamDashboard() {
  const [step, setStep] = useState<number>(0);
  const [intentId, setIntentId] = useState<string>("");
  const [voucherId, setVoucherId] = useState<string>("");
  const [txHash, setTxHash] = useState<string>("");
  const [finalData, setFinalData] = useState<any>(null);

  const startFlow = async () => {
    setStep(1);
    setIntentId("");
    setVoucherId("");
    setTxHash("");
    setFinalData(null);

    try {
      await new Promise(resolve => setTimeout(resolve, 1500));

      // 1. HTTP 402 Handshake
      const res1 = await fetch(`${API_BASE}/api/premium-data`);
      if (res1.status === 402) {
        const data1 = await res1.json();
        setIntentId(data1.intentId);

        setStep(2);

        // 2. HashKey Live Checkout Generation
        const checkoutRes = await fetch(`${API_BASE}/api/agent-checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intentId: data1.intentId, amount: data1.price })
        });
        const checkoutData = await checkoutRes.json();

        if (checkoutData.paymentUrl) {
          // Automatically open the checkout window for the user
          window.open(checkoutData.paymentUrl, '_blank');
        } else {
          console.error("Failed to generate HashKey URL");
        }

        // 3. Poll for Webhook Fulfillment dynamically!
        let isPaid = false;
        let activeVoucher = "";
        while (!isPaid) {
          // Wait 3 seconds before polling
          await new Promise(resolve => setTimeout(resolve, 3000));

          try {
            const statusRes = await fetch(`${API_BASE}/api/status?intentId=${data1.intentId}`);
            if (statusRes.ok) {
              const json = await statusRes.json();
              if (json.status === 'LOCKED_AND_VERIFIED') {
                isPaid = true;
                activeVoucher = json.voucherId;
              }
            }
          } catch (e) { }
        }

        setTxHash("Webhook Verified Execution");
        setVoucherId(activeVoucher);

        setStep(3);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 4. M2M Fulfillment using Verified Voucher
        const res2 = await fetch(`${API_BASE}/api/premium-data`, {
          headers: { 'X-HSP-Voucher-ID': activeVoucher }
        });

        if (res2.ok) {
          const data2 = await res2.json();
          setFinalData(data2);
          await new Promise(resolve => setTimeout(resolve, 1500));
          setStep(4);
        }
      }
    } catch (e) {
      console.error(e);
      setStep(0);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-mono overflow-hidden flex flex-col relative w-full">
      {/* HEADER SECTION */}
      <header className="w-full bg-slate-950 border-b border-slate-800 p-4 flex justify-between items-center z-10 shrink-0">
        <div className="flex items-center gap-3">
          <Zap className="text-cyan-400 w-8 h-8" />
          <h1 className="text-2xl font-bold tracking-widest text-white">
            EPOCHSTREAM<span className="text-cyan-400">.M2M</span>
          </h1>
        </div>
        <button
          onClick={startFlow}
          disabled={step > 0 && step < 4}
          className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold py-2 px-6 rounded uppercase tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(34,211,238,0.4)]"
        >
          {step === 0 ? "Start Live M2M Transaction" : step < 4 ? "Processing..." : "Restart Transaction"}
        </button>
      </header>

      {/* 3-COLUMN SPLIT SCREEN GRID (H-SCREEN) */}
      <main className="flex-1 grid grid-cols-3 divide-x divide-slate-800 h-full">

        <section className="p-6 bg-slate-900 flex flex-col relative">
          <div className="flex items-center gap-2 mb-6 text-slate-400 border-b border-slate-800 pb-2">
            <Bot className="w-5 h-5 text-cyan-400" />
            <h2 className="text-sm font-semibold tracking-wider">BUYER AGENT TERMINAL</h2>
          </div>
          <div className="flex-1 space-y-6 text-sm font-medium">
            {step >= 1 && (
              <div className="flex items-start gap-3 animate-pulse">
                <span className="text-cyan-400">{'>'}</span>
                <p className="text-slate-300">[GET] Requesting Premium Data from Agent B...</p>
              </div>
            )}
            {step >= 2 && (
              <div className="flex items-start gap-3 fade-in duration-500">
                <span className="text-amber-400">{'>'}</span>
                <div>
                  <p className="text-amber-400">[PARSER] Handshake failed. Generating HashKey intent.</p>
                  <p className="text-slate-400 mt-2">Initiating HashKey live API transaction...</p>
                </div>
              </div>
            )}
            {step >= 3 && (
              <div className="flex items-start gap-3 fade-in duration-500">
                <span className="text-cyan-400">{'>'}</span>
                <p className="text-emerald-400">[GET] Re-requesting with Voucher attached...</p>
              </div>
            )}
            {step >= 4 && (
              <div className="flex items-start gap-3 fade-in duration-500">
                <span className="text-emerald-400">{'>'}</span>
                <p className="text-emerald-400">[SUCCESS] Data ingestion complete.</p>
              </div>
            )}
          </div>
        </section>

        <section className="p-6 bg-slate-950 flex flex-col items-center justify-center relative">
          <div className="absolute top-6 left-6 flex items-center gap-2 text-slate-400">
            <Network className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-semibold tracking-wider">HSP SETTLEMENT LAYER</h2>
          </div>

          <div className="flex flex-col items-center justify-center w-full max-w-sm mt-10">
            {step === 0 && (
              <p className="text-slate-600 animate-pulse text-sm">Awaiting Intent...</p>
            )}

            {step === 1 && (
              <div className="flex flex-col items-center">
                <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mb-4" />
                <p className="text-cyan-400 text-sm">Pending 402 Lock...</p>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col items-center space-y-4">
                <Loader2 className="w-16 h-16 text-amber-400 animate-spin" />
                <p className="text-amber-400 font-bold text-center animate-pulse">AWAITING ON-CHAIN CONFIRMATION...</p>
                <div className="bg-slate-900 p-3 rounded text-xs w-full text-center border border-slate-800 text-slate-400 break-all shadow-inner">
                  Please complete the payment in the HashKey Checkout browser tab.
                </div>
              </div>
            )}

            {step >= 3 && (
              <div className={`flex flex-col items-center space-y-4 transition-all duration-500 ${step === 3 ? 'scale-110' : 'scale-100'}`}>
                <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500 shadow-[0_0_30px_rgba(16,185,129,0.3)]">
                  <CheckCircle2 className="w-10 h-10 text-emerald-400" />
                </div>
                <p className="text-emerald-400 font-bold text-lg tracking-widest text-center mt-2">ON-CHAIN SETTLEMENT VALIDATED</p>

                <div className="w-full bg-slate-900 border border-emerald-500/30 p-4 rounded space-y-4 shadow-lg">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Generated Voucher</p>
                    <p className="text-xs text-amber-400 flex items-center gap-1 font-bold bg-slate-950 p-2 rounded">
                      <Key className="w-3 h-3 text-amber-500" /> {voucherId}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="p-6 bg-slate-900 flex flex-col relative text-right">
          <div className="flex items-center justify-end gap-2 mb-6 text-slate-400 border-b border-slate-800 pb-2">
            <h2 className="text-sm font-semibold tracking-wider">SELLER API TERMINAL</h2>
            <Server className="w-5 h-5 text-emerald-400" />
          </div>

          <div className="flex-1 space-y-6 text-sm font-medium flex flex-col items-end">
            {step >= 1 && (
              <div className="bg-amber-500/10 border border-amber-500/20 p-5 rounded w-full text-left shadow-sm">
                <div className="flex items-center gap-2 text-amber-400 mb-3 font-bold">
                  <ShieldAlert className="w-4 h-4" />
                  <span>[402] Access Denied. Payment Required.</span>
                </div>
                <div className="text-slate-400 text-xs font-normal space-y-2 bg-slate-950/50 p-3 rounded">
                  <p>Price: <span className="text-amber-300">0.5 USDT</span></p>
                  <p className="break-all">Intent: <span className="text-slate-300">{intentId || "generating..."}</span></p>
                </div>
              </div>
            )}

            {step >= 3 && (
              <div className="flex items-start justify-end gap-3 w-full fade-in duration-500">
                <p className="text-emerald-400 text-left w-full border-l-2 border-emerald-500 pl-4 py-2 bg-slate-950 p-3 rounded shadow-sm">
                  [200] Voucher Authenticated: <br />
                  <span className="text-amber-400 break-all text-xs inline-block mt-2 mb-3">{voucherId}</span><br />
                  <span className="text-cyan-400 font-bold">Serving JSON Data...</span>
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      {step === 4 && finalData && (
        <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-500">
          <div className="bg-slate-900 border border-cyan-500/40 p-8 rounded-xl max-w-2xl w-full shadow-[0_0_80px_rgba(34,211,238,0.15)] relative">
            <button
              onClick={() => setStep(0)}
              className="absolute -top-4 -right-4 bg-slate-800 hover:bg-slate-700 p-2 rounded-full text-white transition-colors border border-slate-700 shadow-xl"
            >
              ✕
            </button>

            <div className="flex items-center gap-4 mb-6 border-b border-slate-800 pb-5">
              <div className="bg-cyan-500/10 p-3 rounded-full border border-cyan-500/20">
                <Bot className="text-cyan-400 w-8 h-8" />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-white tracking-widest">CONFIDENTIAL AI REPORT INGESTED</h3>
                <p className="text-emerald-400 text-sm mt-1 flex items-center gap-1 font-semibold">
                  <CheckCircle2 className="w-4 h-4" /> Paid Securely via Epochstream Escrow
                </p>
              </div>
            </div>

            <div className="bg-[#0D1117] p-6 rounded-md border border-slate-800 font-mono text-sm overflow-x-auto shadow-inner">
              <pre className="text-slate-300">
                <span className="text-purple-400">const</span> <span className="text-cyan-300">response</span> = {'{'}
                <br />
                &nbsp;&nbsp;<span className="text-cyan-200">"data"</span>: <span className="text-emerald-300">"{finalData.data}"</span>,
                <br />
                &nbsp;&nbsp;<span className="text-cyan-200">"sentimentScore"</span>: <span className="text-orange-300">{finalData.sentimentScore}</span>,
                <br />
                &nbsp;&nbsp;<span className="text-cyan-200">"analysis"</span>: <span className="text-emerald-300">"{finalData.analysis}"</span>,
                <br />
                &nbsp;&nbsp;<span className="text-cyan-200">"timestamp"</span>: <span className="text-emerald-300">"{finalData.timestamp}"</span>
                <br />
                {'}'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
