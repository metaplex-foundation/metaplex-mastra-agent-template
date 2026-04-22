'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/hooks/use-plexchat';
import { ChatMessageBubble } from './chat-message';
import { TypingIndicator } from './typing-indicator';

interface ChatPanelProps {
  messages: ChatMessage[];
  isAgentTyping: boolean;
  isConnected: boolean;
  isWalletConnected: boolean;
  onSendMessage: (content: string) => void;
}

const SUGGESTIONS = [
  'What can you do?',
  'Show me my wallet balance',
  'What tokens do I have?',
];

export function ChatPanel({ messages, isAgentTyping, isConnected, isWalletConnected, onSendMessage }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Debounce guard for suggestion buttons — an accidental double-click
  // would otherwise fire two identical message sends.
  const lastSendRef = useRef(0);

  const canSend = isConnected && isWalletConnected;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll if user is near the bottom already
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isAgentTyping]);

  // Track scroll position for scroll-to-bottom button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function handleScroll() {
      if (!el) return;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      setShowScrollBtn(!isNearBottom);
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || !canSend) return;
    onSendMessage(trimmed);
    setInput('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-resize textarea
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSuggestionClick(suggestion: string) {
    if (!canSend) return;
    const now = Date.now();
    // 500ms guard — covers accidental double-clicks without feeling laggy
    // to a user who genuinely wants to retry.
    if (now - lastSendRef.current < 500) return;
    lastSendRef.current = now;
    onSendMessage(suggestion);
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Message list */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-6">
          {messages.length === 0 ? (
            <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4">
              <div className="text-center">
                <div className="mx-auto mb-8 flex h-44 w-44 items-center justify-center overflow-hidden rounded-[2rem] bg-zinc-900 ring-1 ring-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/metaplex-mark.png" alt="Metaplex" className="h-full w-full object-cover" />
                </div>
                <h2 className="text-lg font-semibold text-white">How can I help?</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Ask a question or try one of the suggestions below.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSuggestionClick(s)}
                    disabled={!canSend}
                    className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <ChatMessageBubble key={msg.id} message={msg} />
              ))}
              {isAgentTyping && <TypingIndicator />}
            </>
          )}
        </div>
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && messages.length > 0 && (
        <div className="pointer-events-none absolute bottom-28 left-0 right-0 flex justify-center">
          <button
            onClick={scrollToBottom}
            className="pointer-events-auto rounded-full border border-zinc-700 bg-zinc-800/90 p-2 text-zinc-400 shadow-lg backdrop-blur-sm transition-all hover:bg-zinc-700 hover:text-white"
            title="Scroll to bottom"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="px-4 pb-4 pt-2">
        <div className="mx-auto max-w-3xl">
          {!isConnected && (
            <p className="mb-2 text-center text-xs text-amber-400/80">
              Not connected to agent. Messages cannot be sent.
            </p>
          )}
          {isConnected && !isWalletConnected && (
            <p className="mb-2 text-center text-xs text-amber-400/80">
              Connect your wallet to start chatting.
            </p>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 p-2 shadow-lg shadow-black/20 transition-colors focus-within:border-indigo-500/50 focus-within:shadow-indigo-500/5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={!isConnected ? 'Waiting for connection...' : !isWalletConnected ? 'Connect your wallet to start chatting...' : 'Type a message...'}
              disabled={!canSend}
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-white placeholder-zinc-500 outline-none disabled:opacity-50"
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || !canSend}
              className="flex-shrink-0 rounded-xl bg-indigo-600 p-2 text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 8H14M9 3L14 8L9 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <p className="mt-1.5 flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-600">
            <span>Press Enter to send, Shift+Enter for new line</span>
            <span aria-hidden="true">·</span>
            <span>
              Powered by{' '}
              <a
                href="https://metaplex.com"
                target="_blank"
                rel="noreferrer noopener"
                className="text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-300 hover:underline"
              >
                Metaplex
              </a>
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
