export function getWsUrl(): string {
  const host = process.env.NEXT_PUBLIC_WS_HOST || 'localhost';
  const port = process.env.NEXT_PUBLIC_WS_PORT || '3002';
  const token = process.env.NEXT_PUBLIC_WS_TOKEN || '';
  return `ws://${host}:${port}?token=${token}`;
}
