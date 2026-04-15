'use client';

import { useMemo, useRef, useEffect, useState } from 'react';
import type { WsLogEntry } from '@/hooks/use-plexchat';
import { JsonTree } from './json-tree';

type Filter = 'all' | 'chat' | 'debug' | 'wallet' | 'errors';

interface MessagesTabProps {
  wsLog: WsLogEntry[];
  onClear: () => void;
}

export function MessagesTab({ wsLog, onClear }: MessagesTabProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (filter === 'all') return wsLog;
    return wsLog.filter((entry) => {
      const type = entry.data.type;
      switch (filter) {
        case 'chat': return type === 'message' || type === 'typing';
        case 'debug': return type.startsWith('debug:');
        case 'wallet': return type.startsWith('wallet_') || type === 'wallet_connect' || type === 'wallet_disconnect';
        case 'errors': return type === 'error';
        default: return true;
      }
    });
  }, [wsLog, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex gap-1">
          {(['all', 'chat', 'debug', 'wallet', 'errors'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-0.5 text-[10px] capitalize ${
                filter === f ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button onClick={onClear} className="text-[10px] text-zinc-500 hover:text-zinc-300">
          Clear
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-zinc-500">
            No messages
          </div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className="rounded px-2 py-1 hover:bg-zinc-800/50 cursor-pointer"
              onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
            >
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-zinc-600 font-mono w-[72px] flex-shrink-0">
                  {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={entry.direction === 'out' ? 'text-blue-400' : 'text-green-400'}>
                  {entry.direction === 'out' ? '\u2192' : '\u2190'}
                </span>
                <span className="font-mono text-zinc-300">{entry.data.type}</span>
              </div>
              {expandedId === entry.id && (
                <div className="mt-1 ml-[88px]">
                  <JsonTree data={entry.data} defaultExpanded />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
