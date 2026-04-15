import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer, type IncomingMessage } from 'http';
import {
  getConfig,
  type ServerTransaction,
  type ServerMessage,
  type TransactionSender,
  type AgentContext,
  type ClientMessage,
} from '@metaplex-agent/shared';
import { createAgent, publicToolNames, autonomousToolNames } from '@metaplex-agent/core';
import { RequestContext } from '@mastra/core/request-context';

/**
 * PlexChat WebSocket Server
 *
 * Implements the PlexChat protocol for real-time communication between
 * web frontends and the Mastra agent. Handles authentication, message
 * routing, wallet state, typing indicators, and transaction bridging.
 */
export class PlexChatServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private walletAddress: string | null = null;
  private agent: ReturnType<typeof createAgent>;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor() {
    this.agent = createAgent();
  }

  /**
   * Start the WebSocket server on the configured port.
   */
  start(): void {
    const config = getConfig();
    const port = config.WEB_CHANNEL_PORT;

    const server = createServer();

    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    server.listen(port, () => {
      console.log(`PlexChat WebSocket server running on ws://localhost:${port}`);
      console.log(`Agent mode: ${config.AGENT_MODE}`);
      console.log(`Agent name: ${config.ASSISTANT_NAME}`);
    });
  }

  /**
   * Handle a new WebSocket connection. Validates the auth token
   * and sets up message handlers.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const config = getConfig();

    // --- Authentication ---
    const token = this.extractToken(req);
    if (token !== config.WEB_CHANNEL_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // --- Track client ---
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));

    // --- Send connected message ---
    this.send(ws, { type: 'connected', jid: 'web:default' });
    this.emitContext();

    // --- Message handler ---
    ws.on('message', (data: RawData) => {
      this.handleMessage(ws, data);
    });
  }

  /**
   * Extract the auth token from the request (query param or header).
   */
  private extractToken(req: IncomingMessage): string | null {
    // Try query parameter first
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    // Try Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  /**
   * Handle an incoming WebSocket message.
   */
  private async handleMessage(ws: WebSocket, data: RawData): Promise<void> {
    // --- Parse JSON ---
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'message':
        await this.handleChatMessage(ws, msg.content, msg.sender_name);
        break;
      case 'wallet_connect':
        this.handleWalletConnect(ws, msg.address);
        break;
      case 'wallet_disconnect':
        this.handleWalletDisconnect();
        break;
      default:
        this.send(ws, {
          type: 'error',
          error: `Unknown message type: ${(msg as { type: string }).type}`,
        });
    }
  }

  /**
   * Handle a chat message: invoke the Mastra agent via streaming and emit
   * debug events over WebSocket as stream chunks arrive.
   */
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
        ['agentAssetAddress', config.AGENT_ASSET_ADDRESS ?? null],
        ['agentTokenMint', config.AGENT_TOKEN_MINT ?? null],
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
                args: (chunk.payload.args as Record<string, unknown>) ?? {},
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

  /**
   * Handle wallet_connect: store address and broadcast confirmation.
   */
  private handleWalletConnect(ws: WebSocket, address: string | undefined): void {
    if (!address?.trim()) {
      this.send(ws, {
        type: 'error',
        error: 'wallet_connect requires a non-empty address string',
      });
      return;
    }

    this.walletAddress = address;
    this.broadcast({ type: 'wallet_connected', address });
    this.emitContext();
  }

  /**
   * Handle wallet_disconnect: clear address and broadcast.
   */
  private handleWalletDisconnect(): void {
    this.walletAddress = null;
    this.broadcast({ type: 'wallet_disconnected' });
    this.emitContext();
  }

  private emitContext(): void {
    const config = getConfig();
    const tools = config.AGENT_MODE === 'autonomous' ? autonomousToolNames : publicToolNames;
    this.broadcast({
      type: 'debug:context',
      agentMode: config.AGENT_MODE,
      model: config.LLM_MODEL,
      assistantName: config.ASSISTANT_NAME,
      walletAddress: this.walletAddress,
      connectedClients: this.clients.size,
      conversationLength: this.conversationHistory.length,
      tools,
    });
  }

  /**
   * Send a message to a single client.
   */
  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a message to all connected clients.
   */
  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}
