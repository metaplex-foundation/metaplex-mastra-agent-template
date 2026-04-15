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
}

export interface WsLogEntry {
  id: string;
  timestamp: Date;
  direction: 'in' | 'out';
  data: ServerMessage | ClientMessage;
}

interface UsePlexChatOptions {
  url: string;
  onTransaction?: (tx: ServerTransaction) => void;
  onDebugEvent?: (event: DebugMessage) => void;
}

interface UsePlexChatReturn {
  messages: ChatMessage[];
  isConnected: boolean;
  isReconnecting: boolean;
  isAgentTyping: boolean;
  sendMessage: (content: string) => void;
  sendWalletConnect: (address: string) => void;
  sendWalletDisconnect: () => void;
  wsLog: WsLogEntry[];
  clearWsLog: () => void;
}

let messageId = 0;
function nextId(): string {
  return `msg-${++messageId}-${Date.now()}`;
}

export function usePlexChat({ url, onTransaction, onDebugEvent }: UsePlexChatOptions): UsePlexChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isAgentTyping, setIsAgentTyping] = useState(false);

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

  const connect = useCallback(() => {
    if (!url) return;

    // Don't create a new connection if one is already open or connecting
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      intentionalCloseRef.current = false;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = 1000;
        setIsReconnecting(false);
      };

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
                { id: nextId(), content: `Error: ${data.error}`, sender: 'agent', timestamp: new Date() },
              ]);
              break;

            case 'wallet_connected':
            case 'wallet_disconnected':
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        // Only update state if this is still the current connection
        if (ws === wsRef.current) {
          setIsConnected(false);
          wsRef.current = null;
        }

        // Don't reconnect if the close was intentional (effect cleanup)
        if (intentionalCloseRef.current) return;

        // Auto-reconnect with exponential backoff
        setIsReconnecting(true);
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, 10000);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after this — reconnect handled there
      };
    } catch {
      // Connection failed, retry
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 10000);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    }
  }, [url, logIncoming]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
      logOutgoing(msg);
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
}
