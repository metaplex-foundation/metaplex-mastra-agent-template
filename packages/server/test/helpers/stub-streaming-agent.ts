/**
 * Stub Mastra-like agent that produces a streaming response shaped exactly
 * like the chunks `PlexChatServer.handleChatMessage` consumes.
 *
 * The server reads from `stream.fullStream.getReader()` and switches on
 * `chunk.type`. We emit a controllable, scripted sequence of chunks per
 * call so tests can deterministically drive:
 *   - text-only replies
 *   - tool calls (which exercise the WS transactionSender path when the
 *     scripted tool actually invokes `transactionSender.sendAndAwait`)
 *   - mixed text + tool sequences
 *
 * The script is reset on every `setScript()`; calling `stream()` consumes
 * the current script once.
 */

import { randomUUID } from 'crypto';

export type ScriptedChunk =
  | { type: 'step-start'; stepType?: 'initial' | 'tool-result' | 'continue' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolName: string; result: unknown; isError?: boolean }
  | { type: 'step-finish'; reason?: string; inputTokens?: number; outputTokens?: number };

/**
 * Higher-level script entry. `runTool` invokes a real tool callable from the
 * scripted run — used to wire `transferSol` into the WS transactionSender.
 */
export type ScriptEntry =
  | { kind: 'text'; content: string }
  | { kind: 'tool-call'; toolName: string; args?: Record<string, unknown>; result?: unknown; isError?: boolean }
  | { kind: 'invoke-tool'; toolName: string; args: Record<string, unknown>; tool: ToolLike; resultText?: string };

export interface ToolLike {
  execute: (args: unknown, ctx: { requestContext: unknown }) => Promise<unknown> | unknown;
}

export interface StreamingStubAgent {
  setScript(script: ScriptEntry[]): void;
  /** Inspect the last messages array passed to stream(). */
  lastMessages: unknown[];
  /** Inspect the last requestContext passed to stream(). */
  lastRequestContext: unknown;
  /** How many times stream() has been called. */
  callCount: number;
  stream(messages: unknown[], opts?: any): Promise<StreamResult>;
}

interface StreamResult {
  fullStream: ReadableStream<{ type: string; payload?: any }>;
  text: Promise<string>;
  totalUsage: Promise<{ inputTokens: number; outputTokens: number } | undefined>;
  finishReason: Promise<string>;
}

export function makeStreamingStubAgent(): StreamingStubAgent {
  let script: ScriptEntry[] = [];
  const agent: StreamingStubAgent = {
    lastMessages: [],
    lastRequestContext: null,
    callCount: 0,
    setScript(s) {
      script = s;
    },
    async stream(messages, opts) {
      agent.lastMessages = messages;
      agent.lastRequestContext = opts?.requestContext;
      agent.callCount += 1;
      const currentScript = script.slice();
      // Reset script for the next call so a single setScript() drives one turn.
      script = [];

      let resolveFinishReason!: (r: string) => void;
      let resolveText!: (t: string) => void;
      let resolveUsage!: (u: { inputTokens: number; outputTokens: number }) => void;
      const finishReasonP = new Promise<string>((r) => { resolveFinishReason = r; });
      const textP = new Promise<string>((r) => { resolveText = r; });
      const usageP = new Promise<{ inputTokens: number; outputTokens: number }>(
        (r) => { resolveUsage = r; },
      );

      let aggregatedText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      const fullStream = new ReadableStream<{ type: string; payload?: any }>({
        async pull(controller) {
          // Emit one initial step-start to satisfy the consumer's step counter.
          controller.enqueue({ type: 'step-start', payload: { stepType: 'initial' } });
          for (const entry of currentScript) {
            // Honor abort signal between steps so abort tests behave. Resolve
            // text with whatever's been accumulated so far rather than '' so
            // partial streams (text emitted, then aborted) are visible to
            // tests that inspect the result text.
            if (opts?.abortSignal?.aborted) {
              controller.close();
              resolveText(aggregatedText);
              resolveUsage({ inputTokens, outputTokens });
              resolveFinishReason('aborted');
              return;
            }
            if (entry.kind === 'text') {
              aggregatedText += entry.content;
              controller.enqueue({
                type: 'text-delta',
                payload: { text: entry.content },
              });
              outputTokens += Math.max(1, Math.ceil(entry.content.length / 4));
            } else if (entry.kind === 'tool-call') {
              const toolCallId = randomUUID();
              controller.enqueue({
                type: 'tool-call',
                payload: { toolCallId, toolName: entry.toolName, args: entry.args ?? {} },
              });
              controller.enqueue({
                type: 'tool-result',
                payload: {
                  toolCallId,
                  toolName: entry.toolName,
                  result: entry.result ?? null,
                  isError: entry.isError ?? false,
                },
              });
            } else if (entry.kind === 'invoke-tool') {
              const toolCallId = randomUUID();
              controller.enqueue({
                type: 'tool-call',
                payload: { toolCallId, toolName: entry.toolName, args: entry.args },
              });
              let result: unknown;
              let isError = false;
              try {
                result = await entry.tool.execute(entry.args, {
                  requestContext: opts?.requestContext,
                });
              } catch (err) {
                result = { error: err instanceof Error ? err.message : String(err) };
                isError = true;
              }
              controller.enqueue({
                type: 'tool-result',
                payload: { toolCallId, toolName: entry.toolName, result, isError },
              });
              if (entry.resultText) {
                aggregatedText += entry.resultText;
                controller.enqueue({
                  type: 'text-delta',
                  payload: { text: entry.resultText },
                });
              }
            }
          }
          // Emit a synthetic step-finish so usage budgeting sees a value.
          controller.enqueue({
            type: 'step-finish',
            payload: {
              stepResult: { reason: 'stop' },
              output: { usage: { inputTokens, outputTokens } },
            },
          });
          controller.close();
          resolveText(aggregatedText);
          resolveUsage({ inputTokens, outputTokens });
          resolveFinishReason('stop');
        },
      });

      return {
        fullStream,
        text: textP,
        totalUsage: usageP,
        finishReason: finishReasonP,
      };
    },
  };
  return agent;
}
