'use client';

import type { SessionTotals } from '@/hooks/use-debug-panel';

interface TotalsTabProps {
  totals: SessionTotals;
}

export function TotalsTab({ totals }: TotalsTabProps) {
  const elapsed = Date.now() - totals.sessionStartTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const avgResponse = totals.messageCount > 0
    ? (totals.totalResponseTimeMs / totals.messageCount / 1000).toFixed(1)
    : '\u2014';

  const toolEntries = Object.entries(totals.toolCallCounts).sort((a, b) => b[1] - a[1]);
  const maxCalls = Math.max(1, ...toolEntries.map(([, v]) => v));

  const hasAnyData = totals.messageCount > 0;

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Token Usage</h3>
        <div className="space-y-1">
          <TokenRow label="Input" value={totals.totalInputTokens} />
          <TokenRow label="Output" value={totals.totalOutputTokens} />
          {totals.totalCachedTokens > 0 && <TokenRow label="Cached" value={totals.totalCachedTokens} />}
          {totals.totalReasoningTokens > 0 && <TokenRow label="Reasoning" value={totals.totalReasoningTokens} />}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Tool Usage</h3>
        {toolEntries.length === 0 ? (
          <span className="text-[10px] text-zinc-500">{hasAnyData ? 'No tool calls yet' : 'No data yet'}</span>
        ) : (
          <div className="space-y-1.5">
            {toolEntries.map(([name, count]) => (
              <div key={name} className="text-[11px]">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-mono text-zinc-300">{name}</span>
                  <span className="text-zinc-500">{count} call{count !== 1 ? 's' : ''}</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{ width: `${(count / maxCalls) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Performance</h3>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Avg response</span>
            <span className="text-zinc-200">{avgResponse}s</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Messages</span>
            <span className="text-zinc-200">{totals.messageCount}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Session</span>
            <span className="text-zinc-200">{minutes}m {seconds}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-200">{value.toLocaleString()}</span>
    </div>
  );
}
