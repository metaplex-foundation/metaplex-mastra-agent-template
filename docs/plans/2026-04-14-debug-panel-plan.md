# Debug Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time debug panel to the agent template UI that shows tool calls, token usage, timing, context state, and raw WebSocket traffic as the agent processes requests.

**Architecture:** Switch server from `agent.generate()` to `agent.stream()`, emitting debug events over WebSocket as stream chunks arrive. UI gets a toggleable right-side debug drawer with four tabs (Steps, Context, Messages, Totals). Chat responses also stream token-by-token as a side benefit.

**Tech Stack:** Mastra stream API, WebSocket debug events, React hooks, Tailwind CSS

**Design doc:** `docs/plans/2026-04-14-debug-panel-design.md`

---

### Task 1: Add Debug Protocol Types

Add debug message type definitions to the shared protocol types.

**Files:**
- Modify: `packages/shared/src/types/protocol.ts`

**Step 1: Add the debug message interfaces**

Add after the `ServerError` interface (line 65) and before the `ServerMessage` union (line 67):

```typescript
// --- Debug Events (Server -> Client) ---

export interface DebugStepStart {
  type: 'debug:step_start';
  step: number;
  stepType: 'initial' | 'tool-result';
}

export interface DebugToolCall {
  type: 'debug:tool_call';
  step: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface DebugToolResult {
  type: 'debug:tool_result';
  step: number;
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface DebugTextDelta {
  type: 'debug:text_delta';
  step: number;
  delta: string;
}

export interface DebugStepComplete {
  type: 'debug:step_complete';
  step: number;
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  durationMs: number;
}

export interface DebugGenerationComplete {
  type: 'debug:generation_complete';
  totalSteps: number;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  totalDurationMs: number;
  traceId?: string;
  finishReason: string;
}

export interface DebugContext {
  type: 'debug:context';
  agentMode: string;
  model: string;
  assistantName: string;
  walletAddress: string | null;
  connectedClients: number;
  conversationLength: number;
  tools: string[];
}
```

**Step 2: Update the ServerMessage union**

Replace the existing `ServerMessage` type with:

```typescript
export type DebugMessage =
  | DebugStepStart
  | DebugToolCall
  | DebugToolResult
  | DebugTextDelta
  | DebugStepComplete
  | DebugGenerationComplete
  | DebugContext;

export type ServerMessage =
  | ServerConnected
  | ServerChatMessage
  | ServerTyping
  | ServerTransaction
  | ServerWalletConnected
  | ServerWalletDisconnected
  | ServerError
  | DebugMessage;
```

**Step 3: Build shared package and verify**

Run: `pnpm --filter @metaplex-agent/shared build`
Expected: Clean build, no errors.

**Step 4: Commit**

```
feat(shared): add debug protocol message types
```

---

### Task 2: Export Tool Names from Core

The Context tab needs to display registered tool names. Export them from the core package.

**Files:**
- Modify: `packages/core/src/tools/index.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Add toolNames export**

In `packages/core/src/tools/index.ts`, after line 13, add:

```typescript
export const toolNames = Object.keys(tools);
```

**Step 2: Re-export toolNames from core index**

In `packages/core/src/index.ts`, ensure `toolNames` is exported. The file currently exports `createAgent`. Add:

```typescript
export { toolNames } from './tools/index.js';
```

**Step 3: Build and verify**

Run: `pnpm --filter @metaplex-agent/core build`
Expected: Clean build.

**Step 4: Commit**

```
feat(core): export tool names for debug panel context
```

---

### Task 3: Switch Server to Streaming with Debug Events

Replace `agent.generate()` with `agent.stream()` and emit debug events over WebSocket.

**Files:**
- Modify: `packages/server/src/websocket.ts`

**Step 1: Add toolNames import**

Update the imports at line 1-12 of `websocket.ts`. Add `toolNames` to the core import:

```typescript
import { createAgent } from '@metaplex-agent/core';
```

becomes:

```typescript
import { createAgent, toolNames } from '@metaplex-agent/core';
```

Also add `DebugMessage` to the shared import (for type safety on broadcast):

```typescript
import {
  getConfig,
  type ServerTransaction,
  type ServerMessage,
  type TransactionSender,
  type AgentContext,
  type ClientMessage,
  type DebugContext,
} from '@metaplex-agent/shared';
```

**Step 2: Add emitContext helper method**

Add a new private method to the `PlexChatServer` class, after `handleWalletDisconnect()` (after line 228):

```typescript
  private emitContext(): void {
    const config = getConfig();
    this.broadcast({
      type: 'debug:context',
      agentMode: config.AGENT_MODE,
      model: config.LLM_MODEL,
      assistantName: config.ASSISTANT_NAME,
      walletAddress: this.walletAddress,
      connectedClients: this.clients.size,
      conversationLength: this.conversationHistory.length,
      tools: toolNames,
    });
  }
```

**Step 3: Emit context on connection**

In `handleConnection()`, after `this.send(ws, { type: 'connected', jid: 'web:default' })` (line 73), add:

```typescript
    this.emitContext();
```

**Step 4: Emit context on wallet state changes**

In `handleWalletConnect()`, after `this.broadcast({ type: 'wallet_connected', address })` (line 219), add:

```typescript
    this.emitContext();
```

In `handleWalletDisconnect()`, after `this.broadcast({ type: 'wallet_disconnected' })` (line 227), add:

```typescript
    this.emitContext();
```

**Step 5: Rewrite handleChatMessage to use streaming**

Replace the entire `handleChatMessage` method (lines 133-204) with:

```typescript
  private async handleChatMessage(
    ws: WebSocket,
    content: string | undefined,
    _senderName?: string
  ): Promise<void> {
    if (!content) {
      this.send(ws, {
        type: 'error',
        error: 'Expected { type: "message", content: "..." }',
      });
      return;
    }

    if (!content.trim()) return;

    const config = getConfig();

    this.broadcast({ type: 'typing', isTyping: true });

    try {
      const transactionSender: TransactionSender = {
        sendTransaction: (tx: ServerTransaction) => this.broadcast(tx),
      };

      const requestContext = new RequestContext<AgentContext>([
        ['walletAddress', this.walletAddress],
        ['transactionSender', transactionSender],
        ['agentMode', config.AGENT_MODE],
      ]);

      let fullMessage = content;
      if (this.walletAddress) {
        fullMessage = `[User wallet: ${this.walletAddress}] ${content}`;
      }

      this.conversationHistory.push({ role: 'user', content: fullMessage });

      const startTime = Date.now();

      const stream = await this.agent.stream(this.conversationHistory, {
        requestContext: requestContext as any,
        maxSteps: 10,
      });

      // Consume the stream and emit debug events
      let currentStep = 0;
      let stepStartTime = Date.now();

      const reader = stream.fullStream.getReader();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;

          switch (chunk.type) {
            case 'step-start':
              currentStep++;
              stepStartTime = Date.now();
              this.broadcast({
                type: 'debug:step_start',
                step: currentStep,
                stepType: currentStep === 1 ? 'initial' : 'tool-result',
              });
              break;

            case 'tool-call':
              this.broadcast({
                type: 'debug:tool_call',
                step: currentStep,
                toolCallId: chunk.payload.toolCallId,
                toolName: chunk.payload.toolName,
                args: chunk.payload.args ?? {},
              });
              break;

            case 'tool-result':
              this.broadcast({
                type: 'debug:tool_result',
                step: currentStep,
                toolCallId: chunk.payload.toolCallId,
                toolName: chunk.payload.toolName,
                result: chunk.payload.result,
                isError: chunk.payload.isError ?? false,
                durationMs: Date.now() - stepStartTime,
              });
              break;

            case 'text-delta':
              this.broadcast({
                type: 'debug:text_delta',
                step: currentStep,
                delta: chunk.payload.text,
              });
              break;

            case 'step-finish':
              this.broadcast({
                type: 'debug:step_complete',
                step: currentStep,
                finishReason: chunk.payload.stepResult?.reason ?? 'unknown',
                usage: {
                  inputTokens: chunk.payload.output?.usage?.inputTokens ?? 0,
                  outputTokens: chunk.payload.output?.usage?.outputTokens ?? 0,
                  reasoningTokens: chunk.payload.output?.usage?.reasoningTokens,
                  cachedInputTokens: chunk.payload.output?.usage?.cachedInputTokens,
                },
                durationMs: Date.now() - stepStartTime,
              });
              stepStartTime = Date.now();
              break;
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Get final output after stream is consumed
      const text = await stream.text;
      const totalUsage = await stream.totalUsage;

      this.conversationHistory.push({ role: 'assistant', content: text });

      this.broadcast({
        type: 'debug:generation_complete',
        totalSteps: currentStep,
        totalUsage: {
          inputTokens: totalUsage?.inputTokens ?? 0,
          outputTokens: totalUsage?.outputTokens ?? 0,
          reasoningTokens: totalUsage?.reasoningTokens,
          cachedInputTokens: totalUsage?.cachedInputTokens,
        },
        totalDurationMs: Date.now() - startTime,
        finishReason: (await stream.finishReason) ?? 'unknown',
      });

      this.broadcast({
        type: 'message',
        content: text,
        sender: config.ASSISTANT_NAME,
      });

      this.emitContext();
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'An unknown error occurred';
      const errorContent = `I encountered an error: ${errorMsg}`;
      this.conversationHistory.push({ role: 'assistant', content: errorContent });
      this.broadcast({
        type: 'message',
        content: errorContent,
        sender: config.ASSISTANT_NAME,
      });
    } finally {
      this.broadcast({ type: 'typing', isTyping: false });
    }
  }
```

**Important note on stream chunk access pattern:** Mastra wraps the AI SDK and its chunks have a `{ type, payload }` structure where properties are nested inside `payload`. If the actual runtime shape differs (e.g., properties are flat on the chunk, not nested in `payload`), adjust the property access accordingly. The server `dev` script uses `tsx watch`, so changes reload automatically — test by sending a chat message and watching the server console for any property access errors.

**Step 6: Build and verify**

Run: `pnpm --filter @metaplex-agent/server build`
Expected: Clean build.

**Step 7: Manual test**

Run the server with `pnpm --filter @metaplex-agent/server dev`. Connect with the UI or a WebSocket client. Send a message and verify:
1. Debug events appear in WebSocket traffic (check browser DevTools Network > WS tab)
2. The final `message` event still arrives with the complete text
3. `debug:context` arrives on connection

**Step 8: Commit**

```
feat(server): switch to streaming and emit debug events
```

---

### Task 4: Extend usePlexChat Hook for Debug Events and Streaming

Update the WebSocket hook to handle debug message types, implement streaming chat messages, and expose a raw WebSocket log.

**Files:**
- Modify: `packages/ui/src/hooks/use-plexchat.ts`

**Step 1: Add debug types and extend ChatMessage**

At the top of the file, update the imports and types:

```typescript
import type {
  ClientMessage,
  ServerMessage,
  ServerTransaction,
  DebugMessage,
} from '@metaplex-agent/shared';

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: Date;
  isStreaming?: boolean;
}

export interface WsLogEntry {
  id: string;
  timestamp: Date;
  direction: 'in' | 'out';
  data: ServerMessage | ClientMessage;
}
```

**Step 2: Update UsePlexChatReturn**

Add new fields to the return type:

```typescript
interface UsePlexChatReturn {
  messages: ChatMessage[];
  isConnected: boolean;
  isReconnecting: boolean;
  isAgentTyping: boolean;
  sendMessage: (content: string) => void;
  sendWalletConnect: (address: string) => void;
  sendWalletDisconnect: () => void;
  // Debug additions
  wsLog: WsLogEntry[];
  clearWsLog: () => void;
  onDebugEvent?: (event: DebugMessage) => void;
}
```

Also update `UsePlexChatOptions`:

```typescript
interface UsePlexChatOptions {
  url: string;
  onTransaction?: (tx: ServerTransaction) => void;
  onDebugEvent?: (event: DebugMessage) => void;
}
```

**Step 3: Add state and refs for streaming and WS log**

Inside `usePlexChat`, add:

```typescript
  const [wsLog, setWsLog] = useState<WsLogEntry[]>([]);
  const streamingTextRef = useRef('');
  const streamingMsgIdRef = useRef<string | null>(null);
  const onDebugEventRef = useRef(onDebugEvent);
  onDebugEventRef.current = onDebugEvent;

  const clearWsLog = useCallback(() => setWsLog([]), []);
```

**Step 4: Add WS log helpers**

Add helper functions for logging:

```typescript
  const logIncoming = useCallback((data: ServerMessage) => {
    setWsLog((prev) => {
      const next = [...prev, { id: nextId(), timestamp: new Date(), direction: 'in' as const, data }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const logOutgoing = useCallback((data: ClientMessage) => {
    setWsLog((prev) => {
      const next = [...prev, { id: nextId(), timestamp: new Date(), direction: 'out' as const, data }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);
```

**Step 5: Update the onmessage handler**

Replace the `ws.onmessage` handler inside `connect()` with a version that handles debug events and streaming:

```typescript
      ws.onmessage = (event) => {
        if (ws !== wsRef.current) return;

        try {
          const data: ServerMessage = JSON.parse(event.data as string);
          logIncoming(data);

          // Forward debug events
          if (data.type.startsWith('debug:')) {
            onDebugEventRef.current?.(data as DebugMessage);
          }

          switch (data.type) {
            case 'connected':
              setIsConnected(true);
              break;

            case 'debug:text_delta': {
              // Stream text into chat
              if (!streamingMsgIdRef.current) {
                const id = nextId();
                streamingMsgIdRef.current = id;
                streamingTextRef.current = data.delta;
                setMessages((prev) => [
                  ...prev,
                  { id, content: data.delta, sender: 'agent', timestamp: new Date(), isStreaming: true },
                ]);
              } else {
                streamingTextRef.current += data.delta;
                const text = streamingTextRef.current;
                const id = streamingMsgIdRef.current;
                setMessages((prev) =>
                  prev.map((m) => (m.id === id ? { ...m, content: text } : m))
                );
              }
              break;
            }

            case 'message':
              setIsAgentTyping(false);
              if (streamingMsgIdRef.current) {
                // Replace streaming message with final version
                const id = streamingMsgIdRef.current;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === id ? { ...m, content: data.content, isStreaming: false } : m
                  )
                );
                streamingMsgIdRef.current = null;
                streamingTextRef.current = '';
              } else {
                // No streaming happened (fallback)
                setMessages((prev) => [
                  ...prev,
                  { id: nextId(), content: data.content, sender: 'agent', timestamp: new Date() },
                ]);
              }
              break;

            case 'typing':
              setIsAgentTyping(data.isTyping);
              break;

            case 'transaction':
              onTransactionRef.current?.(data);
              break;

            case 'error':
              setMessages((prev) => [
                ...prev,
                { id: nextId(), content: `Error: ${data.error}`, sender: 'agent', timestamp: new Date() },
              ]);
              break;

            case 'wallet_connected':
            case 'wallet_disconnected':
              break;

            // All other debug:* types are handled by the onDebugEvent callback above
          }
        } catch {
          // Ignore malformed messages
        }
      };
```

**Step 6: Log outgoing messages**

Update the `send` function to log outgoing messages:

```typescript
  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      logOutgoing(msg);
    }
  }, [logOutgoing]);
```

**Step 7: Update return value**

```typescript
  return {
    messages,
    isConnected,
    isReconnecting,
    isAgentTyping,
    sendMessage,
    sendWalletConnect,
    sendWalletDisconnect,
    wsLog,
    clearWsLog,
  };
```

**Step 8: Verify UI builds**

Run: `pnpm --filter @metaplex-agent/ui typecheck`
Expected: No type errors.

**Step 9: Commit**

```
feat(ui): extend plexchat hook with debug events and streaming
```

---

### Task 5: Create useDebugPanel Hook

New hook that accumulates debug events into structured state for the panel.

**Files:**
- Create: `packages/ui/src/hooks/use-debug-panel.ts`

**Step 1: Write the hook**

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebugMessage, DebugContext } from '@metaplex-agent/shared';

// --- Types ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ToolCallTrace {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export interface StepTrace {
  step: number;
  stepType: 'initial' | 'tool-result';
  toolCalls: ToolCallTrace[];
  text: string;
  usage?: TokenUsage;
  durationMs?: number;
  finishReason?: string;
}

export interface MessageTrace {
  messageId: string;
  startTime: number;
  steps: StepTrace[];
  totalUsage?: TokenUsage;
  totalDurationMs?: number;
  traceId?: string;
  finishReason?: string;
  isComplete: boolean;
}

export interface SessionTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  toolCallCounts: Record<string, number>;
  messageCount: number;
  sessionStartTime: number;
  totalResponseTimeMs: number;
}

export type DebugTab = 'steps' | 'context' | 'messages' | 'totals';

export interface UseDebugPanelReturn {
  isOpen: boolean;
  toggle: () => void;
  activeTab: DebugTab;
  setActiveTab: (tab: DebugTab) => void;
  traces: MessageTrace[];
  context: DebugContext | null;
  sessionTotals: SessionTotals;
  handleDebugEvent: (event: DebugMessage) => void;
}

// --- Hook ---

const STORAGE_KEY = 'debug-panel-open';

export function useDebugPanel(): UseDebugPanelReturn {
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [activeTab, setActiveTab] = useState<DebugTab>('steps');
  const [traces, setTraces] = useState<MessageTrace[]>([]);
  const [context, setContext] = useState<DebugContext | null>(null);
  const [sessionTotals, setSessionTotals] = useState<SessionTotals>({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalReasoningTokens: 0,
    toolCallCounts: {},
    messageCount: 0,
    sessionStartTime: Date.now(),
    totalResponseTimeMs: 0,
  });

  const activeTraceRef = useRef<string | null>(null);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  // Keyboard shortcut: Cmd+D / Ctrl+D
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  const handleDebugEvent = useCallback((event: DebugMessage) => {
    switch (event.type) {
      case 'debug:context':
        setContext(event);
        break;

      case 'debug:step_start': {
        if (event.step === 1) {
          // New generation — create a new trace
          const traceId = `trace-${Date.now()}`;
          activeTraceRef.current = traceId;
          const newTrace: MessageTrace = {
            messageId: traceId,
            startTime: Date.now(),
            steps: [{ step: event.step, stepType: event.stepType, toolCalls: [], text: '' }],
            isComplete: false,
          };
          setTraces((prev) => [newTrace, ...prev]);
          setSessionTotals((prev) => ({ ...prev, messageCount: prev.messageCount + 1 }));
        } else {
          // Additional step in current generation
          setTraces((prev) => {
            const id = activeTraceRef.current;
            return prev.map((t) =>
              t.messageId === id
                ? { ...t, steps: [...t.steps, { step: event.step, stepType: event.stepType, toolCalls: [], text: '' }] }
                : t
            );
          });
        }
        break;
      }

      case 'debug:tool_call': {
        setTraces((prev) => {
          const id = activeTraceRef.current;
          return prev.map((t) => {
            if (t.messageId !== id) return t;
            const steps = t.steps.map((s) =>
              s.step === event.step
                ? {
                    ...s,
                    toolCalls: [
                      ...s.toolCalls,
                      { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
                    ],
                  }
                : s
            );
            return { ...t, steps };
          });
        });
        setSessionTotals((prev) => ({
          ...prev,
          toolCallCounts: {
            ...prev.toolCallCounts,
            [event.toolName]: (prev.toolCallCounts[event.toolName] ?? 0) + 1,
          },
        }));
        break;
      }

      case 'debug:tool_result': {
        setTraces((prev) => {
          const id = activeTraceRef.current;
          return prev.map((t) => {
            if (t.messageId !== id) return t;
            const steps = t.steps.map((s) =>
              s.step === event.step
                ? {
                    ...s,
                    toolCalls: s.toolCalls.map((tc) =>
                      tc.toolCallId === event.toolCallId
                        ? { ...tc, result: event.result, isError: event.isError, durationMs: event.durationMs }
                        : tc
                    ),
                  }
                : s
            );
            return { ...t, steps };
          });
        });
        break;
      }

      case 'debug:text_delta': {
        setTraces((prev) => {
          const id = activeTraceRef.current;
          return prev.map((t) => {
            if (t.messageId !== id) return t;
            const steps = t.steps.map((s) =>
              s.step === event.step ? { ...s, text: s.text + event.delta } : s
            );
            return { ...t, steps };
          });
        });
        break;
      }

      case 'debug:step_complete': {
        setTraces((prev) => {
          const id = activeTraceRef.current;
          return prev.map((t) => {
            if (t.messageId !== id) return t;
            const steps = t.steps.map((s) =>
              s.step === event.step
                ? { ...s, usage: event.usage, durationMs: event.durationMs, finishReason: event.finishReason }
                : s
            );
            return { ...t, steps };
          });
        });
        setSessionTotals((prev) => ({
          ...prev,
          totalInputTokens: prev.totalInputTokens + event.usage.inputTokens,
          totalOutputTokens: prev.totalOutputTokens + event.usage.outputTokens,
          totalCachedTokens: prev.totalCachedTokens + (event.usage.cachedInputTokens ?? 0),
          totalReasoningTokens: prev.totalReasoningTokens + (event.usage.reasoningTokens ?? 0),
        }));
        break;
      }

      case 'debug:generation_complete': {
        setTraces((prev) => {
          const id = activeTraceRef.current;
          return prev.map((t) =>
            t.messageId === id
              ? {
                  ...t,
                  totalUsage: event.totalUsage,
                  totalDurationMs: event.totalDurationMs,
                  traceId: event.traceId,
                  finishReason: event.finishReason,
                  isComplete: true,
                }
              : t
          );
        });
        setSessionTotals((prev) => ({
          ...prev,
          totalResponseTimeMs: prev.totalResponseTimeMs + event.totalDurationMs,
        }));
        activeTraceRef.current = null;
        break;
      }
    }
  }, []);

  return {
    isOpen,
    toggle,
    activeTab,
    setActiveTab,
    traces,
    context,
    sessionTotals,
    handleDebugEvent,
  };
}
```

**Step 2: Verify types**

Run: `pnpm --filter @metaplex-agent/ui typecheck`
Expected: No type errors.

**Step 3: Commit**

```
feat(ui): add useDebugPanel hook for debug state management
```

---

### Task 6: Create JSON Tree Component

Shared component for rendering collapsible JSON in tool args/results and the messages tab.

**Files:**
- Create: `packages/ui/src/components/debug/json-tree.tsx`

**Step 1: Write the component**

```typescript
'use client';

import { useState } from 'react';

interface JsonTreeProps {
  data: unknown;
  defaultExpanded?: boolean;
  maxStringLength?: number;
}

export function JsonTree({ data, defaultExpanded = false, maxStringLength = 200 }: JsonTreeProps) {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  if (!json || json === '{}' || json === 'null' || json === 'undefined') {
    return <span className="text-zinc-500 italic">empty</span>;
  }

  const truncated = json.length > maxStringLength && !defaultExpanded;

  return <JsonBlock content={json} truncated={truncated} maxLength={maxStringLength} />;
}

function JsonBlock({ content, truncated, maxLength }: { content: string; truncated: boolean; maxLength: number }) {
  const [expanded, setExpanded] = useState(false);

  const display = expanded || !truncated ? content : content.slice(0, maxLength) + '...';

  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
        {display}
      </pre>
      {truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-indigo-400 hover:text-indigo-300"
        >
          {expanded ? 'Collapse' : `Show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```
feat(ui): add collapsible JSON tree component for debug panel
```

---

### Task 7: Create Steps Tab Component

The primary debug view showing real-time execution traces.

**Files:**
- Create: `packages/ui/src/components/debug/steps-tab.tsx`

**Step 1: Write the component**

```typescript
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
    : trace.isComplete ? '—' : '...';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
      >
        <span className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${trace.isComplete ? 'bg-green-400' : 'animate-pulse bg-amber-400'}`} />
          <span className="font-medium text-zinc-200">
            Message #{traces_indexOf_workaround(trace)}
          </span>
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

// Simple workaround since we show newest first but want ascending message numbers
function traces_indexOf_workaround(trace: MessageTrace): string {
  const ts = new Date(trace.startTime);
  return ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
```

**Step 2: Commit**

```
feat(ui): add Steps tab component for debug panel
```

---

### Task 8: Create Context Tab Component

Shows agent configuration, connection state, conversation info, and registered tools.

**Files:**
- Create: `packages/ui/src/components/debug/context-tab.tsx`

**Step 1: Write the component**

```typescript
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
      {/* Agent Config */}
      <Section title="Agent">
        <Row label="Mode" value={context?.agentMode ?? '—'} />
        <Row label="Model" value={context?.model ?? '—'} mono />
        <Row label="Name" value={context?.assistantName ?? '—'} />
      </Section>

      {/* Connection */}
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

      {/* Conversation */}
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

      {/* Tools */}
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
```

**Step 2: Commit**

```
feat(ui): add Context tab component for debug panel
```

---

### Task 9: Create Messages Tab Component

Raw WebSocket message log with filtering.

**Files:**
- Create: `packages/ui/src/components/debug/messages-tab.tsx`

**Step 1: Write the component**

```typescript
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

  // Auto-scroll to bottom
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
      {/* Toolbar */}
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

      {/* Message list */}
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
                  {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions)}
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
```

**Step 2: Commit**

```
feat(ui): add Messages tab component for debug panel
```

---

### Task 10: Create Totals Tab Component

Session-level aggregates with token usage and tool call distribution.

**Files:**
- Create: `packages/ui/src/components/debug/totals-tab.tsx`

**Step 1: Write the component**

```typescript
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
    : '—';

  const toolEntries = Object.entries(totals.toolCallCounts).sort((a, b) => b[1] - a[1]);
  const maxCalls = Math.max(1, ...toolEntries.map(([, v]) => v));

  const hasAnyData = totals.messageCount > 0;

  return (
    <div className="space-y-3 p-3">
      {/* Token Usage */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Token Usage</h3>
        <div className="space-y-1">
          <TokenRow label="Input" value={totals.totalInputTokens} />
          <TokenRow label="Output" value={totals.totalOutputTokens} />
          {totals.totalCachedTokens > 0 && <TokenRow label="Cached" value={totals.totalCachedTokens} />}
          {totals.totalReasoningTokens > 0 && <TokenRow label="Reasoning" value={totals.totalReasoningTokens} />}
        </div>
      </div>

      {/* Tool Usage */}
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

      {/* Performance */}
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
```

**Step 2: Commit**

```
feat(ui): add Totals tab component for debug panel
```

---

### Task 11: Create Debug Panel Container

Container component with tab bar that renders the active tab.

**Files:**
- Create: `packages/ui/src/components/debug/debug-panel.tsx`

**Step 1: Write the component**

```typescript
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
      {/* Tab bar */}
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

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'steps' && <StepsTab traces={traces} />}
        {activeTab === 'context' && <ContextTab context={context} messages={messages} isConnected={isConnected} />}
        {activeTab === 'messages' && <MessagesTab wsLog={wsLog} onClear={onClearWsLog} />}
        {activeTab === 'totals' && <TotalsTab totals={sessionTotals} />}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```
feat(ui): add DebugPanel container component with tabs
```

---

### Task 12: Integrate Debug Panel into Page Layout

Wire up the debug panel, toggle button, streaming messages, and keyboard shortcut to the main page.

**Files:**
- Modify: `packages/ui/src/app/page.tsx`
- Modify: `packages/ui/src/components/chat-message.tsx`

**Step 1: Update chat-message.tsx for streaming indicator**

In `packages/ui/src/components/chat-message.tsx`, update the `ChatMessage` import and add a streaming cursor.

Update the import at line 4:

```typescript
import type { ChatMessage } from '@/hooks/use-plexchat';
```

This stays the same, but the `ChatMessage` type now includes `isStreaming?: boolean`.

In the agent message rendering section (the `<Markdown>` block around line 56-58), replace:

```typescript
          <div className="markdown-content text-sm leading-relaxed">
            <Markdown>{message.content}</Markdown>
          </div>
```

with:

```typescript
          <div className="markdown-content text-sm leading-relaxed">
            <Markdown>{message.content}</Markdown>
            {message.isStreaming && (
              <span className="inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-text-bottom" />
            )}
          </div>
```

**Step 2: Rewrite page.tsx**

Replace the entire content of `packages/ui/src/app/page.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import type { ServerTransaction } from '@metaplex-agent/shared';
import { usePlexChat } from '@/hooks/use-plexchat';
import { useDebugPanel } from '@/hooks/use-debug-panel';
import { ChatPanel } from '@/components/chat-panel';
import { TransactionApproval } from '@/components/transaction-approval';
import { DebugPanel } from '@/components/debug/debug-panel';
import { getWsUrl } from './env';

function ConnectionStatus({ isConnected, isReconnecting }: { isConnected: boolean; isReconnecting: boolean }) {
  if (isConnected) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Connected
      </span>
    );
  }
  if (isReconnecting) {
    return (
      <span className="animate-status-pulse flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Reconnecting...
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      Disconnected
    </span>
  );
}

export default function Home() {
  const wallet = useWallet();
  const [pendingTx, setPendingTx] = useState<ServerTransaction | null>(null);

  const debug = useDebugPanel();

  const { messages, isConnected, isReconnecting, isAgentTyping, sendMessage, sendWalletConnect, sendWalletDisconnect, wsLog, clearWsLog } =
    usePlexChat({
      url: getWsUrl(),
      onTransaction: (tx) => setPendingTx(tx),
      onDebugEvent: debug.handleDebugEvent,
    });

  // Sync wallet state with WebSocket server
  useEffect(() => {
    if (!isConnected) return;
    const address = wallet.publicKey?.toBase58() ?? null;
    if (address) {
      sendWalletConnect(address);
    } else {
      sendWalletDisconnect();
    }
  }, [wallet.publicKey, isConnected, sendWalletConnect, sendWalletDisconnect]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-white">PlexChat</h1>
          <ConnectionStatus isConnected={isConnected} isReconnecting={isReconnecting} />
        </div>
        <div className="flex items-center gap-2">
          {/* Debug toggle */}
          <button
            onClick={debug.toggle}
            className={`rounded-lg p-2 transition-colors ${
              debug.isOpen
                ? 'bg-indigo-600/20 text-indigo-400'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title="Toggle debug panel (Cmd+D)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M12 6v6l4 2" />
            </svg>
          </button>
          <WalletMultiButton />
        </div>
      </header>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatPanel
            messages={messages}
            isAgentTyping={isAgentTyping}
            isConnected={isConnected}
            onSendMessage={sendMessage}
          />
        </div>

        {/* Debug panel */}
        {debug.isOpen && (
          <div className="w-[400px] flex-shrink-0">
            <DebugPanel
              activeTab={debug.activeTab}
              onTabChange={debug.setActiveTab}
              traces={debug.traces}
              context={debug.context}
              messages={messages}
              wsLog={wsLog}
              onClearWsLog={clearWsLog}
              sessionTotals={debug.sessionTotals}
              isConnected={isConnected}
            />
          </div>
        )}
      </div>

      {/* Transaction overlay */}
      {pendingTx && (
        <TransactionApproval
          transaction={pendingTx}
          onComplete={() => setPendingTx(null)}
        />
      )}
    </div>
  );
}
```

**Step 3: Verify types compile**

Run: `pnpm --filter @metaplex-agent/ui typecheck`
Expected: No type errors.

**Step 4: Commit**

```
feat(ui): integrate debug panel into main page layout
```

---

### Task 13: Build, Verify, and Fix

Full build of all packages and end-to-end verification.

**Step 1: Build all packages**

Run: `pnpm build`
Expected: All packages build cleanly.

If there are TypeScript errors, fix them. Common issues to watch for:
- Mastra stream chunk property access (`payload.X` vs flat `X`) — fix in server
- Missing type imports in UI components
- `ServerMessage` union not matching all switch cases in `use-plexchat.ts`

**Step 2: Start dev servers**

Run in separate terminals:
- `pnpm --filter @metaplex-agent/server dev`
- `pnpm --filter @metaplex-agent/ui dev`

**Step 3: Manual verification checklist**

1. Open http://localhost:3001 in browser
2. Verify the debug toggle button appears in the header (clock icon)
3. Click it — debug panel should slide in from the right
4. Press Cmd+D — panel should toggle
5. Check Context tab shows agent config (mode, model, name)
6. Connect a wallet — Context tab should update with wallet address
7. Send a message (e.g. "What can you do?")
8. Verify:
   - Chat response streams in token-by-token (with blinking cursor)
   - Steps tab shows the execution trace with timing
   - Messages tab shows raw WebSocket traffic
   - Totals tab shows token counts
9. Send "Show me my wallet balance" (with wallet connected)
10. Verify Steps tab shows tool call (get-balance) with args and result
11. Close debug panel — chat should expand to full width
12. Reopen panel — state should persist (localStorage)

**Step 4: Fix any issues found during manual testing**

Common runtime issues:
- Stream chunk structure mismatch: check server console for "Cannot read property" errors, adjust payload access
- `ReadableStream` async iteration: if `for await` doesn't work with `getReader()`, try wrapping with a helper
- WebSocket message ordering: ensure `debug:text_delta` events arrive before `message`

**Step 5: Commit**

```
feat: debug panel complete with streaming and 4-tab inspector
```
