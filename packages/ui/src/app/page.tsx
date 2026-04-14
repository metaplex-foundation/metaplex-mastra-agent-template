'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import type { ServerTransaction } from '@metaplex-agent/shared';
import { usePlexChat } from '@/hooks/use-plexchat';
import { ChatPanel } from '@/components/chat-panel';
import { TransactionApproval } from '@/components/transaction-approval';
import { getWsUrl } from './env';

export default function Home() {
  const wallet = useWallet();
  const [pendingTx, setPendingTx] = useState<ServerTransaction | null>(null);

  const { messages, isConnected, isAgentTyping, sendMessage, sendWalletConnect, sendWalletDisconnect } =
    usePlexChat({
      url: getWsUrl(),
      onTransaction: (tx) => setPendingTx(tx),
    });

  // Sync wallet state with WebSocket server
  const prevPubkey = useRef<string | null>(null);
  useEffect(() => {
    const address = wallet.publicKey?.toBase58() ?? null;

    if (address && address !== prevPubkey.current) {
      sendWalletConnect(address);
    } else if (!address && prevPubkey.current) {
      sendWalletDisconnect();
    }

    prevPubkey.current = address;
  }, [wallet.publicKey, sendWalletConnect, sendWalletDisconnect]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">PlexChat</h1>
          <span
            className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
            title={isConnected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <WalletMultiButton />
      </header>

      {/* Chat */}
      <ChatPanel
        messages={messages}
        isAgentTyping={isAgentTyping}
        onSendMessage={sendMessage}
      />

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
