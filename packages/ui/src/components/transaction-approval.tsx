'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { useState, useRef, useEffect, useMemo } from 'react';
import type { ServerTransaction } from '@metaplex-agent/shared';
import { solanaCluster } from '@/app/env';

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();

function truncatePubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 4)}${String.fromCharCode(0x2026)}${pk.slice(-4)}`;
}

interface TxPreview {
  instructionCount: number;
  programIds: string[];
  transfers: Array<{ destination: string; sol: number }>;
  decodeFailed: boolean;
}

function decodeTxPreview(base64: string): TxPreview {
  const empty: TxPreview = {
    instructionCount: 0,
    programIds: [],
    transfers: [],
    decodeFailed: false,
  };
  try {
    const bytes = Buffer.from(base64, 'base64');
    const tx = VersionedTransaction.deserialize(bytes);
    const keys = tx.message.staticAccountKeys;
    const instructions = tx.message.compiledInstructions;
    const programIdSet = new Set<string>();
    const transfers: Array<{ destination: string; sol: number }> = [];

    for (const ix of instructions) {
      const programKey = keys[ix.programIdIndex];
      if (!programKey) continue;
      const programId = programKey.toBase58();
      programIdSet.add(programId);

      // Decode SystemProgram Transfer: first 4 bytes = instruction index (little-endian u32),
      // Transfer = 2, followed by 8-byte little-endian u64 lamports.
      if (programId === SYSTEM_PROGRAM_ID && ix.data.length >= 12) {
        const data = ix.data;
        const ixType = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
        if (ixType === 2 && ix.accountKeyIndexes.length >= 2) {
          const destIdx = ix.accountKeyIndexes[1];
          const destKey = keys[destIdx];
          if (destKey) {
            // Read u64 lamports as bigint to avoid precision loss.
            const view = new DataView(data.buffer, data.byteOffset + 4, 8);
            const lamports = view.getBigUint64(0, true);
            const sol = Number(lamports) / LAMPORTS_PER_SOL;
            transfers.push({ destination: destKey.toBase58(), sol });
          }
        }
      }
    }

    return {
      instructionCount: instructions.length,
      programIds: Array.from(programIdSet).slice(0, 3),
      transfers,
      decodeFailed: false,
    };
  } catch {
    return { ...empty, decodeFailed: true };
  }
}

export interface TxApprovalResult {
  correlationId: string;
  signature?: string;
  error?: string;
}

interface TransactionApprovalProps {
  transaction: ServerTransaction;
  onComplete: (result: TxApprovalResult) => void;
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
  const [status, setStatus] = useState<'pending' | 'signing' | 'sending' | 'confirming' | 'success' | 'error'>('pending');
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const modalRef = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const preview = useMemo(() => decodeTxPreview(transaction.transaction), [transaction.transaction]);

  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    };
  }, []);

  // Focus management: capture the previously-focused element, move focus
  // to the primary action, restore on unmount. Screen readers rely on
  // role="dialog" + initial focus being inside the dialog.
  useEffect(() => {
    const previouslyFocused = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    // Prefer the approve button, then the modal root as a fallback. A
    // frame delay lets the buttons mount before we reach for them.
    const raf = requestAnimationFrame(() => {
      if (approveRef.current) {
        approveRef.current.focus();
      } else if (modalRef.current) {
        modalRef.current.focus();
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      // Only restore focus if the previously-focused element is still in
      // the DOM; otherwise focus falls back to document body naturally.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, []);

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

      setStatus('confirming');
      const confirmPromise = connection.confirmTransaction(sig, 'confirmed');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Transaction confirmation timed out after 60 seconds')), 60000)
      );
      await Promise.race([confirmPromise, timeoutPromise]);

      setStatus('success');
      autoCloseTimerRef.current = setTimeout(
        () => onComplete({ correlationId: transaction.correlationId, signature: sig }),
        2000,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
      setStatus('error');
    }
  }

  function handleReject() {
    onComplete({
      correlationId: transaction.correlationId,
      error: 'User rejected transaction',
    });
  }

  function handleCancelAfterError() {
    onComplete({
      correlationId: transaction.correlationId,
      error: error ?? 'Transaction failed',
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // Escape always rejects the pending transaction. Once the tx is in
    // flight (signing/sending/confirming) or succeeded we ignore it so
    // the user can't abandon a running signature round-trip.
    if (event.key === 'Escape') {
      if (status === 'pending') {
        event.preventDefault();
        handleReject();
      } else if (status === 'error') {
        event.preventDefault();
        handleCancelAfterError();
      }
      return;
    }

    if (event.key !== 'Tab') return;

    // Focus trap: collect the currently-visible action buttons and
    // wrap focus between first and last. This keeps keyboard users
    // inside the modal without pulling in a full focus-trap library.
    const candidates: Array<HTMLElement | null> = [];
    if (status === 'pending') {
      candidates.push(rejectRef.current, approveRef.current);
    } else if (status === 'error') {
      candidates.push(cancelRef.current, retryRef.current);
    } else if (status === 'success') {
      // Only the explorer link is focusable at this stage; no trap needed.
      return;
    } else {
      // signing / sending / confirming — nothing focusable, eat Tab.
      event.preventDefault();
      modalRef.current?.focus();
      return;
    }

    const focusable = candidates.filter((el): el is HTMLElement => !!el);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (active === first || !focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    // Only dismiss when the click originated on the backdrop itself,
    // not on something inside the modal content.
    if (event.target === event.currentTarget) {
      if (status === 'pending') {
        handleReject();
      } else if (status === 'error') {
        handleCancelAfterError();
      }
    }
  }

  const cluster = solanaCluster();
  const clusterQuery = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  const explorerUrl = signature
    ? `https://explorer.solana.com/tx/${signature}${clusterQuery}`
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-title"
        aria-describedby="tx-desc"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="mx-4 w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 outline-none"
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-600/20">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-indigo-400">
              <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="flex-1">
            <h2 id="tx-title" className="text-lg font-semibold text-white">Transaction Request</h2>
            {transaction.total && transaction.total > 1 && (
              <p className="text-xs text-zinc-500">
                Transaction {(transaction.index ?? 0) + 1} of {transaction.total}
              </p>
            )}
          </div>
        </div>

        {transaction.message ? (
          <p id="tx-desc" className="mt-3 text-sm leading-relaxed text-zinc-300">{transaction.message}</p>
        ) : (
          <p id="tx-desc" className="sr-only">Review and approve or reject the pending Solana transaction.</p>
        )}

        {/* Decoded preview */}
        {!preview.decodeFailed && preview.instructionCount > 0 && (
          <div className="mt-3 space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
            <div>
              <span className="text-zinc-500">Instructions:</span>{' '}
              <span className="text-zinc-300">{preview.instructionCount}</span>
            </div>
            {typeof transaction.feeSol === 'number' && (
              <div>
                <span className="text-zinc-500">Fee:</span>{' '}
                <span className="text-zinc-300">{transaction.feeSol} SOL</span>
              </div>
            )}
            {preview.transfers.slice(0, 3).map((t, i) => (
              <div key={`transfer-${i}`}>
                <span className="text-zinc-500">Transfer:</span>{' '}
                <span className="text-zinc-300">
                  {t.sol} SOL {String.fromCharCode(0x2192)}{' '}
                  <span className="font-mono">{truncatePubkey(t.destination)}</span>
                </span>
              </div>
            ))}
            {preview.programIds.length > 0 && (
              <div className="truncate">
                <span className="text-zinc-500">Programs:</span>{' '}
                <span className="font-mono text-zinc-300">
                  {preview.programIds.map(truncatePubkey).join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
        {preview.decodeFailed && typeof transaction.feeSol === 'number' && (
          <div className="mt-3 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
            <span className="text-zinc-500">Fee:</span>{' '}
            <span className="text-zinc-300">{transaction.feeSol} SOL</span>
          </div>
        )}

        {/* Pending: show approve/reject buttons */}
        {status === 'pending' && (
          <div className="mt-6 flex gap-3">
            <button
              ref={rejectRef}
              onClick={handleReject}
              className="flex-1 rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Reject
            </button>
            <button
              ref={approveRef}
              onClick={handleApprove}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Approve
            </button>
          </div>
        )}

        {/* Signing / Sending / Confirming: show spinner */}
        {(status === 'signing' || status === 'sending' || status === 'confirming') && (
          <div className="mt-6 flex items-center justify-center gap-3 py-2">
            <Spinner />
            <p className="text-sm text-zinc-400">
              {status === 'signing' ? 'Waiting for wallet...' : status === 'sending' ? 'Sending transaction...' : 'Confirming on-chain...'}
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
              <p className="text-sm font-medium text-green-400">Transaction confirmed!</p>
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
            <p className="mt-3 text-center text-xs text-zinc-500">Closing automatically...</p>
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
                ref={cancelRef}
                onClick={handleCancelAfterError}
                className="flex-1 rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                ref={retryRef}
                onClick={() => { setStatus('pending'); setError(null); setSignature(null); }}
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
