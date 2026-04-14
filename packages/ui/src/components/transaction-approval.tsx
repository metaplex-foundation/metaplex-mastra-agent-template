'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useState } from 'react';
import type { ServerTransaction } from '@metaplex-agent/shared';

interface TransactionApprovalProps {
  transaction: ServerTransaction;
  onComplete: (signature: string | null) => void;
}

export function TransactionApproval({ transaction, onComplete }: TransactionApprovalProps) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [status, setStatus] = useState<'pending' | 'signing' | 'sending' | 'success' | 'error'>('pending');
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    if (!wallet.signTransaction) {
      setError('Wallet does not support signing');
      setStatus('error');
      return;
    }

    try {
      setStatus('signing');
      const bytes = Buffer.from(transaction.transaction, 'base64');
      const tx = VersionedTransaction.deserialize(bytes);

      const signed = await wallet.signTransaction(tx);

      setStatus('sending');
      const sig = await connection.sendRawTransaction(signed.serialize());
      setSignature(sig);
      setStatus('success');
      onComplete(sig);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
      setStatus('error');
    }
  }

  function handleReject() {
    onComplete(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
        <h3 className="text-lg font-semibold text-white">Transaction Request</h3>

        {transaction.message && (
          <p className="mt-2 text-sm text-zinc-300">{transaction.message}</p>
        )}

        {transaction.total && transaction.total > 1 && (
          <p className="mt-1 text-xs text-zinc-500">
            Transaction {(transaction.index ?? 0) + 1} of {transaction.total}
          </p>
        )}

        {status === 'pending' && (
          <div className="mt-6 flex gap-3">
            <button
              onClick={handleReject}
              className="flex-1 rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Reject
            </button>
            <button
              onClick={handleApprove}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Approve
            </button>
          </div>
        )}

        {(status === 'signing' || status === 'sending') && (
          <p className="mt-6 text-center text-sm text-zinc-400">
            {status === 'signing' ? 'Waiting for wallet...' : 'Sending transaction...'}
          </p>
        )}

        {status === 'success' && signature && (
          <div className="mt-4">
            <p className="text-sm text-green-400">Transaction sent!</p>
            <p className="mt-1 break-all font-mono text-xs text-zinc-500">{signature}</p>
            <button
              onClick={() => onComplete(signature)}
              className="mt-4 w-full rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              Close
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-4">
            <p className="text-sm text-red-400">{error}</p>
            <div className="mt-4 flex gap-3">
              <button
                onClick={handleReject}
                className="flex-1 rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => { setStatus('pending'); setError(null); }}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
