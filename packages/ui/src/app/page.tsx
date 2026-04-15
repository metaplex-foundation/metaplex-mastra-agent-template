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
import { getWsUrl } from './env';

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
  const [pendingTx, setPendingTx] = useState<ServerTransaction | null>(null);

  const debug = useDebugPanel();

  const { messages, isConnected, isReconnecting, isAgentTyping, sendMessage, sendWalletConnect, sendWalletDisconnect, wsLog, clearWsLog } =
    usePlexChat({
      url: getWsUrl(),
      onTransaction: (tx) => setPendingTx(tx),
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

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">PlexChat</h1>
          <ConnectionStatus isConnected={isConnected} isReconnecting={isReconnecting} />
        </div>
        <div className="flex items-center gap-2">
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

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatPanel
            messages={messages}
            isAgentTyping={isAgentTyping}
            isConnected={isConnected}
            onSendMessage={sendMessage}
          />
        </div>

        {debug.isOpen && (
          <div className="w-[400px] flex-shrink-0">
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
        )}
      </div>

      {/* Transaction overlay */}
      {pendingTx && (
        <TransactionApproval
          transaction={pendingTx}
          onComplete={() => setPendingTx(null)}
        />
      )}
    </div>
  );
}
