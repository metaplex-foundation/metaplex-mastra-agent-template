'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  isError?: boolean;
}

export interface WsLogEntry {
  id: string;
  timestamp: Date;
  direction: 'in' | 'out';
  data: ServerMessage | ClientMessage;
}

interface UsePlexChatOptions {
  url: string;
  token?: string;
  onTransaction?: (tx: ServerTransaction) => void;
  onDebugEvent?: (event: DebugMessage) => void;
}

interface UsePlexChatReturn {
  messages: ChatMessage[];
  isConnected: boolean;
  isReconnecting: boolean;
  isAgentTyping: boolean;
  error: string | null;
  sendMessage: (content: string) => void;
  sendWalletConnect: (address: string) => void;
  sendWalletDisconnect: () => void;
  sendTxResult: (correlationId: string, signature: string) => void;
  sendTxError: (correlationId: string, reason: string) => void;
  wsLog: WsLogEntry[];
  clearWsLog: () => void;
}

let messageId = 0;
function nextId(): string {
  return `msg-${++messageId}-${Date.now()}`;
}

export function usePlexChat({ url, token, onTransaction, onDebugEvent }: UsePlexChatOptions): UsePlexChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectDelayRef = useRef(1000);
  const intentionalCloseRef = useRef(false);
  const onTransactionRef = useRef(onTransaction);
  onTransactionRef.current = onTransaction;

  const [wsLog, setWsLog] = useState<WsLogEntry[]>([]);
  const streamingTextRef = useRef('');
  const streamingMsgIdRef = useRef<string | null>(null);
  const onDebugEventRef = useRef(onDebugEvent);
  onDebugEventRef.current = onDebugEvent;

  // Buffer outgoing messages while the socket is closed/reconnecting so they
  // aren't silently dropped mid-reconnect.
  const outgoingQueueRef = useRef<ClientMessage[]>([]);

  const clearWsLog = useCallback(() => setWsLog([]), []);

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

  const flushOutgoingQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outgoingQueueRef.current.length > 0) {
      const msg = outgoingQueueRef.current.shift()!;
      ws.send(JSON.stringify(msg));
      logOutgoing(msg);
    }
  }, [logOutgoing]);

  const connect = useCallback(() => {
    if (!url) return;

    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      intentionalCloseRef.current = false;
      // Auth via WebSocket subprotocol (RFC 6455 Sec-WebSocket-Protocol).
      // The server echoes the `bearer` subprotocol back on accept. If a token
      // is missing we still open the socket so the server can reject cleanly
      // (and surface an `Unauthorized` error via a 4001 close).
      const protocols = token ? ['bearer', token] : undefined;
      const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = 1000;
        setIsReconnecting(false);
        // A successful handshake clears any prior auth error.
        setError(null);
      };

      ws.onmessage = (event) => {
        if (ws !== wsRef.current) return;

        try {
          const data: ServerMessage = JSON.parse(event.data as string);
          logIncoming(data);

          if (data.type.startsWith('debug:')) {
            onDebugEventRef.current?.(data as DebugMessage);
          }

          switch (data.type) {
            case 'connected':
              setIsConnected(true);
              // Flush anything queued while we were offline
              flushOutgoingQueue();
              break;

            case 'debug:text_delta': {
              // Clear the typing indicator once streaming starts (redundant with
              // the bubble, and it should clear on close too)
              setIsAgentTyping(false);
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
                const id = streamingMsgIdRef.current;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === id ? { ...m, content: data.content, isStreaming: false } : m
                  )
                );
                streamingMsgIdRef.current = null;
                streamingTextRef.current = '';
              } else {
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
                { id: nextId(), content: data.error, sender: 'agent', timestamp: new Date(), isError: true },
              ]);
              break;

            case 'wallet_connected':
            case 'wallet_disconnected':
              break;
          }
        } catch (err) {
          console.warn('PlexChat: malformed server message', err);
        }
      };

      ws.onclose = (event) => {
        if (ws === wsRef.current) {
          setIsConnected(false);
          wsRef.current = null;
        }
        // Typing dots should not outlive a dead socket
        setIsAgentTyping(false);

        // 4001 Unauthorized — token was rejected. Stop reconnecting and
        // surface a user-visible error so they don't sit in an infinite
        // reconnect loop with a bad token.
        if (event.code === 4001) {
          intentionalCloseRef.current = true;
          setIsReconnecting(false);
          setError('Unauthorized: check your token');
          return;
        }

        if (intentionalCloseRef.current) return;

        setIsReconnecting(true);
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, 10000);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (event) => {
        console.error('PlexChat: WebSocket error', event);
      };
    } catch (err) {
      console.error('PlexChat: connect failed', err);
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 10000);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    }
  }, [url, token, logIncoming, flushOutgoingQueue]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      logOutgoing(msg);
    } else {
      // Queue for delivery on reconnect. Cap to avoid unbounded growth if the
      // user keeps sending while offline for a long time.
      if (outgoingQueueRef.current.length < 50) {
        outgoingQueueRef.current.push(msg);
      } else {
        console.warn('PlexChat: outgoing queue full, dropping message', msg);
      }
    }
  }, [logOutgoing]);

  const sendMessage = useCallback(
    (content: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          content,
          sender: 'user',
          timestamp: new Date(),
        },
      ]);
      send({ type: 'message', content });
    },
    [send],
  );

  const sendWalletConnect = useCallback(
    (address: string) => {
      send({ type: 'wallet_connect', address });
    },
    [send],
  );

  const sendWalletDisconnect = useCallback(() => {
    send({ type: 'wallet_disconnect' });
  }, [send]);

  const sendTxResult = useCallback(
    (correlationId: string, signature: string) => {
      send({ type: 'tx_result', correlationId, signature });
    },
    [send],
  );

  const sendTxError = useCallback(
    (correlationId: string, reason: string) => {
      send({ type: 'tx_error', correlationId, reason });
    },
    [send],
  );

  return {
    messages,
    isConnected,
    isReconnecting,
    isAgentTyping,
    error,
    sendMessage,
    sendWalletConnect,
    sendWalletDisconnect,
    sendTxResult,
    sendTxError,
    wsLog,
    clearWsLog,
  };
}
