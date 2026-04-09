/**
 * Shared proxy infrastructure for integration proxies (Google, Notion).
 * Provides per-container token management used by google-proxy.ts
 * and notion-mcp-proxy.ts.
 */
import crypto from 'crypto';

// Per-container token map: token → groupFolder
// Tokens are issued when containers start and removed when they stop.
const tokenMap = new Map<string, string>();

/** Issue a token for a container. Called from container-runner. */
export function issueProxyToken(groupFolder: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokenMap.set(token, groupFolder);
  return token;
}

/** Revoke a token when a container stops. */
export function revokeProxyToken(token: string): void {
  tokenMap.delete(token);
}

/** Validate token and return the groupFolder it's bound to, or null. */
export function validateToken(token: string | undefined): string | null {
  if (!token) return null;
  return tokenMap.get(token) ?? null;
}

export function readBody(
  req: import('http').IncomingMessage,
  maxBytes = 1_048_576, // 1MB
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

export function jsonResponse(
  res: import('http').ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
