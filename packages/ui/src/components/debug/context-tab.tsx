'use client';

import { useState } from 'react';
import type { DebugContext } from '@metaplex-agent/shared';
import type { ChatMessage } from '@/hooks/use-plexchat';

interface ContextTabProps {
  context: DebugContext | null;
  messages: ChatMessage[];
  isConnected: boolean;
}

export function ContextTab({ context, messages, isConnected }: ContextTabProps) {
  const [showHistory, setShowHistory] = useState(false);

  const userMsgs = messages.filter((m) => m.sender === 'user').length;
  const agentMsgs = messages.filter((m) => m.sender === 'agent').length;
  const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  return (
    <div className="space-y-3 p-3">
      <Section title="Agent">
        <Row label="Mode" value={context?.agentMode ?? '\u2014'} />
        <Row label="Model" value={context?.model ?? '\u2014'} mono />
        <Row label="Name" value={context?.assistantName ?? '\u2014'} />
      </Section>

      <Section title="Connection">
        <Row
          label="Status"
          value={
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          }
        />
        <Row label="Wallet" value={context?.walletAddress ? truncateAddress(context.walletAddress) : 'None'} mono />
        <Row label="Clients" value={String(context?.connectedClients ?? 0)} />
      </Section>

      <Section title="Conversation">
        <Row label="Messages" value={`${messages.length} (${userMsgs} user, ${agentMsgs} agent)`} />
        <Row label="Est. tokens" value={`~${estimatedTokens.toLocaleString()}`} />
        <Row label="Server history" value={String(context?.conversationLength ?? 0)} />
        {messages.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="mt-1 text-[10px] text-indigo-400 hover:text-indigo-300"
          >
            {showHistory ? 'Hide message history' : 'Show message history'}
          </button>
        )}
        {showHistory && (
          <div className="mt-1.5 max-h-60 overflow-y-auto rounded bg-black/30 p-2">
            {messages.map((m) => (
              <div key={m.id} className="border-b border-zinc-800/50 py-1 last:border-0">
                <span className={`text-[10px] font-medium ${m.sender === 'user' ? 'text-indigo-400' : 'text-green-400'}`}>
                  {m.sender}:
                </span>
                <p className="text-[10px] text-zinc-400 line-clamp-2">{m.content}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Tools">
        {context?.tools && context.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {context.tools.map((name) => (
              <span key={name} className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-300">
                {name}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[10px] text-zinc-500">No tools registered</span>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-zinc-200 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}
