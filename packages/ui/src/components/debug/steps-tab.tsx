'use client';

import { useState } from 'react';
import type { MessageTrace, StepTrace, ToolCallTrace } from '@/hooks/use-debug-panel';
import { JsonTree } from './json-tree';

interface StepsTabProps {
  traces: MessageTrace[];
}

export function StepsTab({ traces }: StepsTabProps) {
  if (traces.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Send a message to see execution traces
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {traces.map((trace, i) => (
        <TraceBlock key={trace.messageId} trace={trace} defaultOpen={i === 0} />
      ))}
    </div>
  );
}

function TraceBlock({ trace, defaultOpen }: { trace: MessageTrace; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  const duration = trace.totalDurationMs
    ? `${(trace.totalDurationMs / 1000).toFixed(1)}s`
    : trace.isComplete ? '\u2014' : '...';

  const timeLabel = new Date(trace.startTime).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
      >
        <span className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${trace.isComplete ? 'bg-green-400' : 'animate-pulse bg-amber-400'}`} />
          <span className="font-medium text-zinc-200">{timeLabel}</span>
          <span className="text-zinc-500">
            {trace.steps.length} step{trace.steps.length !== 1 ? 's' : ''}
          </span>
        </span>
        <span className="flex items-center gap-2 text-zinc-500">
          <span>{duration}</span>
          <span className="text-[10px]">{open ? '\u25B2' : '\u25BC'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          {trace.steps.map((step) => (
            <StepBlock key={step.step} step={step} />
          ))}

          {trace.isComplete && trace.totalUsage && (
            <div className="border-t border-zinc-800/50 pt-2 text-[10px] text-zinc-500 flex gap-4">
              <span>Total: {trace.totalUsage.inputTokens} in / {trace.totalUsage.outputTokens} out</span>
              {(trace.totalUsage.cachedInputTokens ?? 0) > 0 && (
                <span>{trace.totalUsage.cachedInputTokens} cached</span>
              )}
              {trace.finishReason && <span>Finish: {trace.finishReason}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepBlock({ step }: { step: StepTrace }) {
  const hasToolCalls = step.toolCalls.length > 0;

  return (
    <div className="rounded border border-zinc-800/50 bg-zinc-950/50 px-2.5 py-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-zinc-300">
          Step {step.step}
          <span className="ml-1.5 text-zinc-600">({step.stepType})</span>
        </span>
        <span className="flex items-center gap-2 text-zinc-500">
          {step.usage && (
            <span>{step.usage.inputTokens} in / {step.usage.outputTokens} out</span>
          )}
          {step.durationMs != null && <span>{step.durationMs}ms</span>}
        </span>
      </div>

      {hasToolCalls && (
        <div className="mt-1.5 space-y-1.5">
          {step.toolCalls.map((tc) => (
            <ToolCallBlock key={tc.toolCallId} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ tc }: { tc: ToolCallTrace }) {
  const [showArgs, setShowArgs] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const isError = tc.isError === true;

  return (
    <div className={`rounded px-2 py-1.5 text-[11px] ${isError ? 'bg-red-950/30 border border-red-500/20' : 'bg-zinc-900/50'}`}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="text-indigo-400 font-mono">{tc.toolName}</span>
          {tc.durationMs != null && <span className="text-zinc-600">{tc.durationMs}ms</span>}
          {isError && <span className="text-red-400">error</span>}
        </span>
        <span className="flex gap-2">
          <button
            onClick={() => setShowArgs(!showArgs)}
            className="text-zinc-500 hover:text-zinc-300"
          >
            {showArgs ? 'hide' : 'args'}
          </button>
          {tc.result !== undefined && (
            <button
              onClick={() => setShowResult(!showResult)}
              className="text-zinc-500 hover:text-zinc-300"
            >
              {showResult ? 'hide' : 'result'}
            </button>
          )}
        </span>
      </div>
      {showArgs && (
        <div className="mt-1">
          <JsonTree data={tc.args} />
        </div>
      )}
      {showResult && tc.result !== undefined && (
        <div className="mt-1">
          <JsonTree data={tc.result} />
        </div>
      )}
    </div>
  );
}
