'use client';

import Markdown from 'react-markdown';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { ChatMessage } from '@/hooks/use-plexchat';

interface ChatMessageProps {
  message: ChatMessage;
}

// Schemes we refuse to render as live hyperlinks because they can execute
// script or embed untrusted payloads. If the LLM emits one of these we
// degrade gracefully to the raw text.
const BLOCKED_URL_SCHEMES = /^\s*(javascript|data|vbscript|file):/i;

interface SafeLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  children?: ReactNode;
}

function SafeLink({ href, children, ...rest }: SafeLinkProps) {
  if (!href || BLOCKED_URL_SCHEMES.test(href)) {
    // Strip the dangerous href and render as plain text so the user can
    // still see what the model emitted without clicking into it.
    return <span {...rest}>{children}</span>;
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function ChatMessageBubble({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user';
  const isError = message.isError === true;

  if (isError) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[75%] rounded-2xl border border-red-500/20 bg-red-950/40 px-4 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex-shrink-0 text-sm text-red-400">
              {/* Warning icon */}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 1.5L14.5 13H1.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M8 6.5V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
              </svg>
            </span>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-red-300">
              {message.content}
            </p>
          </div>
          <p className="mt-1 text-[10px] text-red-400/50">
            {message.timestamp.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {message.content}
          </p>
        ) : (
          <div className="markdown-content text-sm leading-relaxed break-words [overflow-wrap:anywhere]">
            <Markdown components={{ a: SafeLink }}>{message.content}</Markdown>
            {message.isStreaming === true ? (
              <span
                aria-hidden="true"
                className="inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-text-bottom"
              />
            ) : null}
          </div>
        )}
        <p
          className={`mt-1 text-[10px] ${
            isUser ? 'text-indigo-200' : 'text-zinc-500'
          }`}
        >
          {message.timestamp.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </div>
    </div>
  );
}
