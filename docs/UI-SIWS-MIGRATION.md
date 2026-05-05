# PlexChat v2 SIWS Migration Guide (chat-template UI)

Audience: maintainers of the sibling `metaplex-agent-chat-template` repo (the canonical hosted chat UI). This is a sketch / migration guide for the PR that updates the chat-template to speak the v2 PlexChat protocol.

This document lives in the agent-template repo because the protocol is owned here. Cross-link to it from your PR description in the chat-template repo.

## 1. What changed in v2

PlexChat v2 replaces the `WEB_CHANNEL_TOKEN` shared-secret with a **Sign-In-With-Solana (SIWS)** handshake. The wallet that signs the SIWS challenge is the wallet bound to the session — there is no separate `wallet_connect` step, and the legacy `?token=`, `Sec-WebSocket-Protocol: bearer`, and `Authorization: Bearer` auth methods are all rejected. The agent now also enforces a tiered authorization model (`owner` / `allowlist` / `open`) and a per-wallet sliding-window rate limit. Full details and message schemas: [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md).

For the chat-template this means: drop tokens everywhere, sign a challenge on connect, and gate the chat UI on `authenticated`.

## 2. Files to edit in the chat-template repo

| File | Purpose | Estimated change |
|------|---------|------------------|
| `src/types/plexchat-protocol.ts` | Wire-format type definitions | Add `auth_challenge`, `authenticated`, `auth_error`, `auth_response` types; remove any `wallet_connect`/`wallet_connected` types if present |
| `src/hooks/use-plexchat.ts` | The WebSocket hook | Largest change — rewrite the connect path to drive the SIWS handshake (see §5 below). Track new `authState` enum; gate `send` on it |
| `src/lib/profile-store.ts` | LocalStorage profile schema + validation | Drop `token` field from `Profile` schema, validation, and zod / runtime guards. Add a one-line "ignore stale `token` on read" shim (see §6) |
| `src/components/profile/profile-form.tsx` | Profile editor UI | Remove the `token` input, its `Show/Hide` toggle, and the share-link encoding/decoding of the `token` query param |
| Any "profile pill" / connected-wallet display component | UI | Show the post-auth `walletAddress` from the hook instead of the wallet-adapter button's separate state |

The total diff is small (a few hundred lines net) — the bulk is in the hook.

## 3. Canonical SIWS message builder (copy-paste)

This MUST match the agent's builder byte-for-byte. The single source of truth is [`packages/shared/src/siws.ts`](../packages/shared/src/siws.ts). Inline this snippet in the chat-template instead of pulling in a new package:

```ts
// src/lib/siws.ts (chat-template)
//
// Canonical SIWS message builder. Must match
// agent-template's packages/shared/src/siws.ts byte-for-byte.

export interface SiwsParams {
  agentName: string;
  agentAsset: string | null;
  network: 'solana-mainnet' | 'solana-devnet';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function buildSiwsMessage(p: SiwsParams): string {
  return [
    `Sign in to ${p.agentName}`,
    '',
    `Agent: ${p.agentAsset ?? 'unregistered'}`,
    `Network: ${p.network}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${p.issuedAt}`,
    `Expires: ${p.expiresAt}`,
  ].join('\n');
}
```

The blank line after the greeting is intentional and load-bearing: wallets render the string verbatim, and any whitespace difference between the wallet display and the server's expected message fails verification.

## 4. New connection lifecycle

The hook now exposes a five-state machine. The UI should react to each state explicitly — no more "connected" or "disconnected" boolean.

```
                +-------------+
   open WS ---> | connecting  |
                +------+------+
                       |
                       | "connected" + "auth_challenge" received
                       v
                +---------------+
                | unauthenticated |
                +-------+-------+
                        |
                        | wallet present, signMessage available, user clicked "Connect"
                        v
                +----------------+
                | authenticating |
                +-------+--------+
                        |
              ----------+----------
              |                   |
   "authenticated"           "auth_error"
              |                   |
              v                   v
       +-------------+      +-----------+
       | authenticated|     |  failed   |
       +-------------+      +-----------+
                                  |
                                  | (terminal — close 4001; do NOT auto-reconnect)
```

What the UI should show in each state:

| State | UI |
|-------|----|
| `connecting` | "Connecting to agent..." spinner; chat input disabled |
| `unauthenticated` | "Sign in with your Solana wallet to chat" callout; show "Connect" button. If `wallet.signMessage` is null, swap for a "This wallet does not support message signing — please use Phantom or Solflare" notice |
| `authenticating` | Modal/overlay: "Sign the message in your wallet to authenticate"; chat input still disabled |
| `authenticated` | Profile pill shows `walletAddress` + `isOwner` badge; chat input enabled; transactions accepted |
| `failed` | Error banner with the human-readable `auth_error.message`; "Try again" button that triggers a fresh WebSocket connection (new nonce, new signature) |

## 5. `usePlexChat` SIWS flow — concrete sketch

Pseudo-code. Adapt to the hook's existing state-management style (Zustand, useReducer, etc.):

```ts
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { buildSiwsMessage } from '@/lib/siws';

type AuthState =
  | 'connecting'
  | 'unauthenticated'
  | 'authenticating'
  | 'authenticated'
  | 'failed';

export function usePlexChat(profile: Profile) {
  const wallet = useWallet();
  const [authState, setAuthState] = useState<AuthState>('connecting');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [authError, setAuthError] = useState<{ code: string; message: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const challengeRef = useRef<AuthChallenge | null>(null);

  // Connect — note: NO ?token=, NO subprotocol.
  useEffect(() => {
    const ws = new WebSocket(profile.wsUrl);
    wsRef.current = ws;
    setAuthState('connecting');
    setAuthError(null);

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'connected') return; // no-op; wait for challenge

      if (msg.type === 'auth_challenge') {
        challengeRef.current = msg;
        setAuthState('unauthenticated');
        return;
      }

      if (msg.type === 'authenticated') {
        setWalletAddress(msg.walletAddress);
        setIsOwner(msg.isOwner);
        setAuthState('authenticated');
        return;
      }

      if (msg.type === 'auth_error') {
        setAuthError({ code: msg.code, message: msg.message });
        setAuthState('failed');
        return;
      }

      // chat-plane messages: only deliver to the rest of the hook once authenticated
      if (authStateRef.current === 'authenticated') {
        handleChatPlaneMessage(msg);
      }
    };

    ws.onclose = (event) => {
      if (event.code === 4001) {
        // Terminal. Do NOT auto-reconnect — that burns nonces and never recovers.
        setAuthState('failed');
        return;
      }
      // Other close codes: schedule reconnect with exponential backoff;
      // a fresh connection will get a new nonce and a new SIWS handshake.
      scheduleReconnect();
    };

    return () => ws.close();
  }, [profile.wsUrl]);

  // Triggered by the user clicking "Connect" once we have the challenge.
  const signIn = useCallback(async () => {
    const challenge = challengeRef.current;
    const ws = wsRef.current;
    if (!challenge || !ws) return;

    if (!wallet.publicKey || !wallet.signMessage) {
      setAuthError({
        code: 'wallet_unsupported',
        message: 'This wallet cannot sign messages. Use Phantom or Solflare.',
      });
      setAuthState('failed');
      return;
    }

    setAuthState('authenticating');

    try {
      const canonical = buildSiwsMessage({
        agentName: challenge.agentName,
        agentAsset: challenge.agentAsset,
        network: challenge.network,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      });
      const messageBytes = new TextEncoder().encode(canonical);

      // wallet-adapter signMessage returns a Uint8Array (the raw 64-byte Ed25519 signature)
      const signatureBytes = await wallet.signMessage(messageBytes);

      ws.send(
        JSON.stringify({
          type: 'auth_response',
          publicKey: wallet.publicKey.toBase58(),
          signature: bs58.encode(signatureBytes),
          message: canonical,
        }),
      );
      // Stay in 'authenticating' until we receive 'authenticated' or 'auth_error'.
    } catch (err) {
      // User rejected the signing prompt, or wallet threw.
      setAuthError({
        code: 'user_rejected',
        message: err instanceof Error ? err.message : 'Signing was cancelled.',
      });
      setAuthState('failed');
      // Don't close the socket here — let the server's nonce expire naturally,
      // OR call ws.close() if you want to free the slot immediately.
    }
  }, [wallet]);

  // Gate sends on authenticated.
  const send = (payload: ChatPlaneMessage) => {
    if (authState !== 'authenticated') return;
    wsRef.current?.send(JSON.stringify(payload));
  };

  return { authState, walletAddress, isOwner, authError, signIn, send };
}
```

Key points to internalise:

1. **`wallet.signMessage` may be `null`.** Some wallets (notably some hardware paths) don't implement it. Gate the "Connect" button on `wallet.signMessage != null` and show a friendly message otherwise. This is a v1 limitation worth documenting in the chat-template's README.

2. **Encoding.** `new TextEncoder().encode(canonical)` is the bytes the wallet signs. The signature returned by wallet-adapter is already a `Uint8Array`; base58-encode it for the wire with `bs58.encode`. The server base58-decodes and feeds it to `nacl.sign.detached.verify` against the same UTF-8 bytes — so an exact match between what you sign and what you put in `auth_response.message` is required.

3. **`message` field in `auth_response` must be the exact canonical string.** The server re-checks that the issued nonce appears inside it before verifying the signature — if you trim, normalise newlines, or lose the blank line, you'll get `message_mismatch`.

4. **Close code `4001` is terminal.** Never call `scheduleReconnect()` from that branch.

## 6. Share-link compatibility break

Existing share links the chat-template emits look something like:

```
https://chat.example.com/#wsUrl=wss%3A%2F%2Fagent.example.com&name=Treasury&token=abc123&network=mainnet
```

In v2 the `token` field is gone. New share links contain only `wsUrl`, `name`, and `network`. To avoid breaking users who paste old links:

- **On read** (decoding a share link): if the URL hash contains `token=...`, ignore it but emit `console.warn("Share link contains a legacy auth token; ignoring (server now requires SIWS).")`. Do NOT throw or refuse to load.
- **On write** (generating a new share link): never include `token`.

Same pattern for localStorage: `Profile` previously had `{ name, wsUrl, token, preset, customRpcUrl, customCluster }`. Drop `token` from the type and validation. Add a one-line read-side shim:

```ts
function readProfile(raw: string): Profile {
  const parsed = JSON.parse(raw);
  if ('token' in parsed) {
    delete parsed.token; // legacy field — ignored under v2
  }
  return ProfileSchema.parse(parsed);
}
```

Plan to remove the read-side shim 30 days after the v2 release once persistent storage has had time to be rewritten on natural saves.

## 7. Test approach (Vitest, no real wallet)

The chat-template already uses Vitest. Mock the WebSocket and a fake wallet — no Solana RPC or real signing keys required.

```ts
// src/hooks/__tests__/use-plexchat.test.ts
import { renderHook, act, waitFor } from '@testing-library/react';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildSiwsMessage } from '@/lib/siws';

class MockWebSocket {
  static last: MockWebSocket;
  onmessage?: (ev: MessageEvent) => void;
  onclose?: (ev: CloseEvent) => void;
  sent: string[] = [];
  constructor(public url: string) { MockWebSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  close() {}
  emit(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent); }
}

beforeEach(() => {
  // @ts-expect-error: stub global
  globalThis.WebSocket = MockWebSocket;
});

it('signs the canonical message and sends auth_response', async () => {
  const keypair = nacl.sign.keyPair();
  const wallet = {
    publicKey: { toBase58: () => bs58.encode(keypair.publicKey) },
    signMessage: vi.fn(async (bytes: Uint8Array) =>
      nacl.sign.detached(bytes, keypair.secretKey),
    ),
  };
  // Inject the wallet via your existing wallet provider mock.

  const { result } = renderHook(() => usePlexChat(testProfile));

  // Drive the handshake from the "server" side.
  act(() => {
    MockWebSocket.last.emit({ type: 'connected', jid: 'web:test' });
    MockWebSocket.last.emit({
      type: 'auth_challenge',
      nonce: 'nonce-123',
      issuedAt: '2026-05-04T19:00:00.000Z',
      expiresAt: '2026-05-04T19:01:00.000Z',
      agentName: 'TestBot',
      agentAsset: null,
      network: 'solana-devnet',
      authMode: 'open',
    });
  });

  await waitFor(() => expect(result.current.authState).toBe('unauthenticated'));

  await act(async () => {
    await result.current.signIn();
  });

  // 1. signMessage was called with the exact canonical bytes.
  const expectedCanonical = buildSiwsMessage({
    agentName: 'TestBot',
    agentAsset: null,
    network: 'solana-devnet',
    nonce: 'nonce-123',
    issuedAt: '2026-05-04T19:00:00.000Z',
    expiresAt: '2026-05-04T19:01:00.000Z',
  });
  expect(wallet.signMessage).toHaveBeenCalledWith(
    new TextEncoder().encode(expectedCanonical),
  );

  // 2. auth_response payload shape is correct.
  const sent = JSON.parse(MockWebSocket.last.sent[0]);
  expect(sent.type).toBe('auth_response');
  expect(sent.message).toBe(expectedCanonical);
  expect(typeof sent.signature).toBe('string');
  expect(typeof sent.publicKey).toBe('string');

  // 3. Round-trip the success path.
  act(() => {
    MockWebSocket.last.emit({
      type: 'authenticated',
      walletAddress: sent.publicKey,
      isOwner: false,
      sessionId: 'sess-1',
    });
  });
  await waitFor(() => expect(result.current.authState).toBe('authenticated'));
});
```

A second test should drive the failure path: emit `auth_error` then a `4001` close, assert `authState === 'failed'`, and assert that no reconnect WebSocket is created (e.g., assert `MockWebSocket.last` is unchanged after a few hundred ms).

## 8. Cross-references

- Protocol spec: [`WEBSOCKET_PROTOCOL.md`](../WEBSOCKET_PROTOCOL.md)
- Canonical SIWS message builder: [`packages/shared/src/siws.ts`](../packages/shared/src/siws.ts)
- Server-side auth-mode tiering and rate limiting: see `WEBSOCKET_PROTOCOL.md` §"Authorization Tiers" and §"Per-Wallet Rate Limiting"
- v2.0 protocol changelog entry: bottom of `WEBSOCKET_PROTOCOL.md`
