# Debug Panel Design

## Purpose

A toggleable debug panel in the agent template UI that gives developers real-time visibility into agent internals: tool calls, token usage, timing, context state, and raw WebSocket traffic. Designed for developers iterating on custom agents built from this template.

## Architecture Overview

### Streaming Migration

Switch from `agent.generate()` to `agent.stream()` on the server. This enables:
- Real-time debug events emitted as steps happen
- Token-by-token chat response streaming
- Per-step tool call visibility before the full response completes

### Data Flow

```
agent.stream() fullStream
        │
        ├─ text delta ──────► debug:text_delta    ──► UI streams chat response
        ├─ tool call ───────► debug:tool_call     ──► UI shows tool invocation
        ├─ tool result ─────► debug:tool_result   ──► UI shows tool output
        ├─ step finish ─────► debug:step_complete ──► UI shows step summary
        └─ stream end ──────► debug:generation_complete ──► UI shows totals
                             + message (final text)       ──► backward compat
```

Debug events are always emitted by the server. The UI ignores them if the panel is closed. No server-side toggle needed.

## New WebSocket Message Types

### Server → Client (debug events)

```typescript
// A new LLM step is starting
interface DebugStepStart {
  type: 'debug:step_start';
  step: number;
  stepType: 'initial' | 'tool-result';
}

// Agent is invoking a tool
interface DebugToolCall {
  type: 'debug:tool_call';
  step: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// Tool returned a result
interface DebugToolResult {
  type: 'debug:tool_result';
  step: number;
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

// A chunk of response text (for streaming the chat reply)
interface DebugTextDelta {
  type: 'debug:text_delta';
  step: number;
  delta: string;
}

// A step has finished
interface DebugStepComplete {
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

// All steps complete, final summary
interface DebugGenerationComplete {
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
```

These types go in `packages/shared/src/types/protocol.ts` alongside existing message types.

## Server Changes (packages/server)

### websocket.ts - handleChatMessage()

Replace `agent.generate()` with `agent.stream()`. Consume `fullStream` and emit debug events:

```typescript
async handleChatMessage(content: string) {
  this.broadcast({ type: 'typing', isTyping: true });

  // Build requestContext (unchanged)
  const requestContext = new RequestContext<AgentContext>([...]);

  this.conversationHistory.push({ role: 'user', content: fullMessage });

  const startTime = Date.now();
  const stream = await this.agent.stream(this.conversationHistory, {
    requestContext: requestContext as any,
    maxSteps: 10,
  });

  let currentStep = 0;
  let stepStartTime = Date.now();
  let accumulatedText = '';

  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      case 'step-start':
        currentStep++;
        stepStartTime = Date.now();
        this.broadcast({
          type: 'debug:step_start',
          step: currentStep,
          stepType: chunk.stepType,
        });
        break;

      case 'tool-call':
        this.broadcast({
          type: 'debug:tool_call',
          step: currentStep,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
        });
        break;

      case 'tool-result':
        this.broadcast({
          type: 'debug:tool_result',
          step: currentStep,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          result: chunk.result,
          isError: chunk.isError ?? false,
          durationMs: Date.now() - stepStartTime,
        });
        break;

      case 'text-delta':
        accumulatedText += chunk.textDelta;
        this.broadcast({
          type: 'debug:text_delta',
          step: currentStep,
          delta: chunk.textDelta,
        });
        break;

      case 'step-finish':
        this.broadcast({
          type: 'debug:step_complete',
          step: currentStep,
          finishReason: chunk.finishReason ?? 'unknown',
          usage: {
            inputTokens: chunk.usage?.inputTokens ?? 0,
            outputTokens: chunk.usage?.outputTokens ?? 0,
            reasoningTokens: chunk.usage?.reasoningTokens,
            cachedInputTokens: chunk.usage?.cachedInputTokens,
          },
          durationMs: Date.now() - stepStartTime,
        });
        stepStartTime = Date.now();
        break;
    }
  }

  // Get final output
  const totalUsage = await stream.totalUsage;
  const finishReason = await stream.finishReason;
  const text = await stream.text;

  // Add to conversation history
  this.conversationHistory.push({ role: 'assistant', content: text });

  // Emit final summary
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
    traceId: (await stream.traceId) ?? undefined,
    finishReason: finishReason ?? 'unknown',
  });

  // Send final message (backward compatible)
  this.broadcast({
    type: 'message',
    content: text,
    sender: config.ASSISTANT_NAME,
  });

  this.broadcast({ type: 'typing', isTyping: false });
}
```

Note: The exact chunk types from `fullStream` need to be verified against Mastra's actual stream implementation. The above is based on the AI SDK stream protocol that Mastra wraps.

## UI Changes (packages/ui)

### Toggle Mechanism

- Small terminal/bug icon button in the header, next to the wallet button
- Keyboard shortcut: `Cmd+D` (Mac) / `Ctrl+D` (Windows/Linux)
- Panel state persisted to localStorage so it survives page refresh

### Layout

When open, the debug panel is a right-side drawer (~400px wide). The chat area shrinks to accommodate it. CSS transition for smooth open/close.

```
┌─────────────────────────────────────────────────────────────┐
│  Header: PlexChat    ● Connected    [🔧] [Wallet]          │
├────────────────────────────────┬────────────────────────────┤
│                                │  [Steps] [Context]         │
│                                │  [Messages] [Totals]       │
│         Chat Area              │────────────────────────────│
│    (shrinks when panel open)   │                            │
│                                │   Debug panel content      │
│                                │   (selected tab)           │
│                                │                            │
│                                │                            │
├────────────────────────────────┤                            │
│  [Message input]               │                            │
└────────────────────────────────┴────────────────────────────┘
```

### New Hook: useDebugPanel

Manages debug panel state. Consumes debug WebSocket events and structures them.

```typescript
interface DebugState {
  isOpen: boolean;
  activeTab: 'steps' | 'context' | 'messages' | 'totals';

  // Steps tab - per-message execution traces
  traces: Map<string, MessageTrace>;  // keyed by message ID

  // Messages tab - raw WebSocket log
  wsLog: WsLogEntry[];

  // Totals tab - session aggregates
  sessionTotals: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalReasoningTokens: number;
    toolCallCounts: Record<string, number>;
    messageCount: number;
    sessionStartTime: number;
    avgResponseTimeMs: number;
  };
}

interface MessageTrace {
  messageId: string;
  startTime: number;
  steps: StepTrace[];
  totalUsage?: TokenUsage;
  totalDurationMs?: number;
  traceId?: string;
  finishReason?: string;
  isComplete: boolean;
}

interface StepTrace {
  step: number;
  stepType: 'initial' | 'tool-result';
  toolCalls: ToolCallTrace[];
  textDelta: string;
  usage?: TokenUsage;
  durationMs?: number;
  finishReason?: string;
}

interface ToolCallTrace {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}
```

### New Components

#### DebugPanel

Container component with tab bar and content area.

```
packages/ui/src/components/debug/
  debug-panel.tsx       - Container with tabs
  steps-tab.tsx         - Steps timeline view
  context-tab.tsx       - Agent context view
  messages-tab.tsx      - Raw WebSocket log
  totals-tab.tsx        - Session aggregates
  json-tree.tsx         - Collapsible JSON renderer (shared)
```

#### Steps Tab

- Lists message traces in reverse chronological order
- Each trace is collapsible, showing step-by-step timeline
- Active trace (currently streaming) is expanded by default and animates in
- Tool calls show expandable input/output JSON
- Errors highlighted in red
- Per-step token counts and timing
- Total summary at the bottom of each trace

#### Context Tab

- Agent config section: mode, model, name, max steps
- Connection section: status indicator, wallet address, client count
- Conversation section: message count, estimated token count, expandable raw history
- Tools section: list of registered tool names

The context data requires the server to emit it. Add a new message:

```typescript
interface DebugContextUpdate {
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

Emitted on: connection, wallet connect/disconnect, and after each generation complete.

#### Messages Tab

- Scrollable list of all WebSocket messages with timestamps
- Direction arrows: → for client-to-server, ← for server-to-client
- Filter dropdown: All, Chat, Debug, Wallet, Errors
- Expandable JSON payloads
- Clear button to reset the log
- Client messages captured in the hook before sending, server messages captured on receipt

#### Totals Tab

- Token usage breakdown: input, output, cached, reasoning
- Tool usage bar chart (horizontal bars showing relative call counts)
- Performance: average response time, message count, session duration
- All values update in real-time as new generations complete

### Chat Streaming

With `debug:text_delta` events, the chat response can now stream progressively:

- When a `debug:text_delta` arrives, append to a "streaming message" in the messages array
- The streaming message has a special flag (`isStreaming: true`) so the UI shows a cursor
- When the final `message` event arrives, replace the streaming message with the final version
- If the debug panel is closed, the streaming still works (the text deltas still arrive)

This is a UX improvement for the chat itself, not just the debug panel.

## Changes by Package

### packages/shared

- `types/protocol.ts`: Add all `Debug*` message types to `ServerMessage` union

### packages/core

- No changes needed. The agent definition and tools are unchanged.

### packages/server

- `websocket.ts`: Replace `agent.generate()` with `agent.stream()` + fullStream consumption loop. Emit debug events. Emit `debug:context` on state changes.

### packages/ui

- `hooks/use-plexchat.ts`: Handle `debug:*` message types, implement text streaming, log all WebSocket messages
- `hooks/use-debug-panel.ts`: New hook for debug state management
- `app/page.tsx`: Add debug panel toggle button, render DebugPanel, adjust layout
- `components/debug/*.tsx`: New debug panel components (6 files)
- `components/chat-message.tsx`: Support streaming message state (cursor indicator)

## Open Questions / Risks

1. **Mastra stream chunk types**: The exact chunk type names (`step-start`, `tool-call`, `text-delta`, etc.) need verification against Mastra's actual `fullStream` implementation. The design is based on the AI SDK stream protocol. If types differ, the server-side consumption loop adapts but the debug event types stay the same.

2. **Tool call timing**: `fullStream` may not emit a discrete event when a tool starts executing vs. when the LLM decides to call it. The `durationMs` on `debug:tool_result` may measure from step start rather than from the tool call event. This is acceptable for v1.

3. **Conversation token estimation**: The Context tab shows "estimated tokens" for conversation history. This would be a rough heuristic (chars / 4) rather than an actual tokenizer count. Good enough for developer awareness of context growth.

4. **Large JSON payloads**: Tool inputs/outputs could be large. The JSON tree component should truncate values over ~1000 chars with an expand option, and the Messages tab should cap stored entries (e.g., last 500 messages).
