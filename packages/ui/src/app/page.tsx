'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import type { ServerTransaction } from '@metaplex-agent/shared';
import { usePlexChat } from '@/hooks/use-plexchat';
import { useDebugPanel } from '@/hooks/use-debug-panel';
import { ChatPanel } from '@/components/chat-panel';
import { TransactionApproval } from '@/components/transaction-approval';
import { DebugPanel } from '@/components/debug/debug-panel';
import { wsUrl, wsToken } from './env';

function ConnectionStatus({ isConnected, isReconnecting }: { isConnected: boolean; isReconnecting: boolean }) {
  if (isConnected) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Connected
      </span>
    );
  }
  if (isReconnecting) {
    return (
      <span className="animate-status-pulse flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Reconnecting...
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      Disconnected
    </span>
  );
}

export default function Home() {
  const wallet = useWallet();
  const [txQueue, setTxQueue] = useState<ServerTransaction[]>([]);

  const debug = useDebugPanel();

  const { messages, isConnected, isReconnecting, isAgentTyping, error, sendMessage, sendWalletConnect, sendWalletDisconnect, sendTxResult, sendTxError, wsLog, clearWsLog } =
    usePlexChat({
      url: wsUrl(),
      token: wsToken(),
      onTransaction: (tx) => setTxQueue((prev) => [...prev, tx]),
      onDebugEvent: debug.handleDebugEvent,
    });

  // Sync wallet state with WebSocket server
  useEffect(() => {
    if (!isConnected) return;
    const address = wallet.publicKey?.toBase58() ?? null;
    if (address) {
      sendWalletConnect(address);
    } else {
      sendWalletDisconnect();
    }
  }, [wallet.publicKey, isConnected, sendWalletConnect, sendWalletDisconnect]);

  // Guard: warn the user if they try to close/refresh the tab while a
  // transaction approval is still pending. Losing the window abandons
  // the correlationId and the agent will time out.
  useEffect(() => {
    if (txQueue.length === 0) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Setting returnValue is required for legacy browsers.
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [txQueue.length]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-gradient-to-b from-zinc-900/60 to-zinc-950 px-5 py-5">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/metaplex-logo-white.png"
              alt="Metaplex"
              className="h-6 w-auto"
            />
            <span className="h-7 w-px bg-zinc-700" aria-hidden="true" />
            <span className="text-base font-medium text-zinc-400">Agent</span>
          </div>
          <ConnectionStatus isConnected={isConnected} isReconnecting={isReconnecting} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={debug.toggle}
            className={`rounded-lg p-2 transition-colors ${
              debug.isOpen
                ? 'bg-indigo-600/20 text-indigo-400'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title="Toggle debug panel (Cmd+D)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
              <path d="M7 8h2" />
              <path d="M7 12h4" />
            </svg>
          </button>
          <WalletMultiButton />
        </div>
      </header>

      {/* Auth / connection error banner (surfaced from use-plexchat) */}
      {error && (
        <div
          role="alert"
          className="border-b border-red-500/30 bg-red-950/40 px-4 py-2 text-center text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatPanel
            messages={messages}
            isAgentTyping={isAgentTyping}
            isConnected={isConnected}
            isWalletConnected={!!wallet.publicKey}
            onSendMessage={sendMessage}
          />
        </div>

        {debug.isOpen && (
          <>
            {/* Desktop: side-by-side panel. Mobile: full-screen overlay with dismiss. */}
            <div
              className="fixed inset-0 z-40 bg-black/60 md:hidden"
              onClick={debug.toggle}
              aria-hidden="true"
            />
            <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-shrink-0 flex-col bg-zinc-950 md:static md:z-auto md:w-[400px]">
              <DebugPanel
                activeTab={debug.activeTab}
                onTabChange={debug.setActiveTab}
                traces={debug.traces}
                context={debug.context}
                messages={messages}
                wsLog={wsLog}
                onClearWsLog={clearWsLog}
                sessionTotals={debug.sessionTotals}
                isConnected={isConnected}
              />
            </div>
          </>
        )}
      </div>

      {/* Transaction overlay */}
      {txQueue.length > 0 && (
        <TransactionApproval
          transaction={txQueue[0]}
          onComplete={(result) => {
            if (result.signature) {
              sendTxResult(result.correlationId, result.signature);
              setTxQueue((prev) => prev.slice(1));
            } else {
              // Reject or error — abort the whole multi-tx queue. The agent
              // decides what to do next based on the tx_error notification.
              sendTxError(result.correlationId, result.error ?? 'Transaction failed');
              setTxQueue([]);
            }
          }}
        />
      )}
    </div>
  );
}
