'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { useState } from 'react';
import type { ServerTransaction } from '@metaplex-agent/shared';

interface TransactionApprovalProps {
  transaction: ServerTransaction;
  onComplete: (signature: string | null) => void;
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-20" />
      <path d="M12 2C6.48 2 2 6.48 2 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 flex-shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-300"
      title="Copy signature"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-green-400">
          <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25"/>
          <path d="M3.5 10.5H3C2.44772 10.5 2 10.0523 2 9.5V3C2 2.44772 2.44772 2 3 2H9.5C10.0523 2 10.5 2.44772 10.5 3V3.5" stroke="currentColor" strokeWidth="1.25"/>
        </svg>
      )}
    </button>
  );
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

  const explorerUrl = signature
    ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-600/20">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-indigo-400">
              <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-white">Transaction Request</h3>
            {transaction.total && transaction.total > 1 && (
              <p className="text-xs text-zinc-500">
                Transaction {(transaction.index ?? 0) + 1} of {transaction.total}
              </p>
            )}
          </div>
        </div>

        {transaction.message && (
          <p className="mt-3 text-sm leading-relaxed text-zinc-300">{transaction.message}</p>
        )}

        {/* Pending: show approve/reject buttons */}
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

        {/* Signing / Sending: show spinner */}
        {(status === 'signing' || status === 'sending') && (
          <div className="mt-6 flex items-center justify-center gap-3 py-2">
            <Spinner />
            <p className="text-sm text-zinc-400">
              {status === 'signing' ? 'Waiting for wallet...' : 'Sending transaction...'}
            </p>
          </div>
        )}

        {/* Success: show signature + explorer link */}
        {status === 'success' && signature && (
          <div className="mt-4">
            <div className="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0 text-green-400">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25"/>
                <path d="M5.5 8L7.5 10L10.5 6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <p className="text-sm font-medium text-green-400">Transaction sent!</p>
            </div>
            <div className="mt-2 flex items-center rounded-lg bg-zinc-800 px-3 py-2">
              <p className="flex-1 truncate font-mono text-xs text-zinc-500">{signature}</p>
              <CopyButton text={signature} />
            </div>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
              >
                View on Explorer
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6 3H3V13H13V10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M9 2H14V7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M14 2L7 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
                </svg>
              </a>
            )}
            <button
              onClick={() => onComplete(signature)}
              className="mt-4 w-full rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              Close
            </button>
          </div>
        )}

        {/* Error: show error + retry/cancel */}
        {status === 'error' && (
          <div className="mt-4">
            <div className="flex items-start gap-2 rounded-lg bg-red-950/40 px-3 py-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="mt-0.5 flex-shrink-0 text-red-400">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25"/>
                <path d="M10 6L6 10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
                <path d="M6 6L10 10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              </svg>
              <p className="text-sm text-red-300">{error}</p>
            </div>
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
