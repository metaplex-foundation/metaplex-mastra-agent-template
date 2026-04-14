'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  ServerMessage,
  ServerTransaction,
} from '@metaplex-agent/shared';

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: Date;
}

interface UsePlexChatOptions {
  url: string;
  onTransaction?: (tx: ServerTransaction) => void;
}

interface UsePlexChatReturn {
  messages: ChatMessage[];
  isConnected: boolean;
  isAgentTyping: boolean;
  sendMessage: (content: string) => void;
  sendWalletConnect: (address: string) => void;
  sendWalletDisconnect: () => void;
}

let messageId = 0;
function nextId(): string {
  return `msg-${++messageId}-${Date.now()}`;
}

export function usePlexChat({ url, onTransaction }: UsePlexChatOptions): UsePlexChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isAgentTyping, setIsAgentTyping] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectDelayRef = useRef(1000);
  const onTransactionRef = useRef(onTransaction);
  onTransactionRef.current = onTransaction;

  const connect = useCallback(() => {
    if (!url) return;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = 1000;
      };

      ws.onmessage = (event) => {
        try {
          const data: ServerMessage = JSON.parse(event.data as string);

          switch (data.type) {
            case 'connected':
              setIsConnected(true);
              break;

            case 'message':
              setIsAgentTyping(false);
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  content: data.content,
                  sender: 'agent',
                  timestamp: new Date(),
                },
              ]);
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
                {
                  id: nextId(),
                  content: `Error: ${data.error}`,
                  sender: 'agent',
                  timestamp: new Date(),
                },
              ]);
              break;

            case 'wallet_connected':
            case 'wallet_disconnected':
              // Acknowledgements — no UI action needed
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        // Auto-reconnect with exponential backoff
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
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

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
    isAgentTyping,
    sendMessage,
    sendWalletConnect,
    sendWalletDisconnect,
  };
}
