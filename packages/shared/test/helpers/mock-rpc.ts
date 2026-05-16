import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

type RpcHandler = (params: unknown[]) => unknown;

export interface MockRpc {
  url: string;
  on(method: string, handler: RpcHandler): void;
  calls: { method: string; params: unknown[] }[];
  close(): Promise<void>;
}

export async function startMockRpc(): Promise<MockRpc> {
  const handlers = new Map<string, RpcHandler>();
  const calls: { method: string; params: unknown[] }[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (!handler) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } }));
        return;
      }
      try {
        const result = handler(params ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    on(method, handler) { handlers.set(method, handler); },
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function blockhashFixture() {
  return {
    context: { slot: 1 },
    value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 },
  };
}
