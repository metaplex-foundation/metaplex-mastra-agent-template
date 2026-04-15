'use client';

import type { DebugTab, MessageTrace, SessionTotals } from '@/hooks/use-debug-panel';
import type { DebugContext } from '@metaplex-agent/shared';
import type { ChatMessage, WsLogEntry } from '@/hooks/use-plexchat';
import { StepsTab } from './steps-tab';
import { ContextTab } from './context-tab';
import { MessagesTab } from './messages-tab';
import { TotalsTab } from './totals-tab';

interface DebugPanelProps {
  activeTab: DebugTab;
  onTabChange: (tab: DebugTab) => void;
  traces: MessageTrace[];
  context: DebugContext | null;
  messages: ChatMessage[];
  wsLog: WsLogEntry[];
  onClearWsLog: () => void;
  sessionTotals: SessionTotals;
  isConnected: boolean;
}

const TABS: { id: DebugTab; label: string }[] = [
  { id: 'steps', label: 'Steps' },
  { id: 'context', label: 'Context' },
  { id: 'messages', label: 'Messages' },
  { id: 'totals', label: 'Totals' },
];

export function DebugPanel({
  activeTab,
  onTabChange,
  traces,
  context,
  messages,
  wsLog,
  onClearWsLog,
  sessionTotals,
  isConnected,
}: DebugPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex border-b border-zinc-800">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 px-2 py-2 text-[11px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-indigo-500 text-indigo-400'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'steps' && <StepsTab traces={traces} />}
        {activeTab === 'context' && <ContextTab context={context} messages={messages} isConnected={isConnected} />}
        {activeTab === 'messages' && <MessagesTab wsLog={wsLog} onClear={onClearWsLog} />}
        {activeTab === 'totals' && <TotalsTab totals={sessionTotals} />}
      </div>
    </div>
  );
}
