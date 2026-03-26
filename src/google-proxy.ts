/**
 * Google Workspace proxy for container isolation.
 * Containers call this proxy instead of running gws CLI directly.
 * The proxy executes gws with real credentials so containers never see them.
 *
 * Endpoints:
 *   POST /gws           - Execute a gws CLI command
 *   POST /auth/exchange  - Exchange OAuth code for tokens
 *   POST /auth/disconnect - Revoke token and delete credentials
 *   GET  /auth/status    - Check if credentials exist for a group
 */
import crypto from 'crypto';
import { exec } from 'child_process';
import { createServer, Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

const CREDENTIALS_DIR = path.join(DATA_DIR, 'gws-credentials');
const GWS_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'gws');
const GWS_TIMEOUT = 60_000;

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
function validateToken(token: string | undefined): string | null {
  if (!token) return null;
  return tokenMap.get(token) ?? null;
}

function getCredentialsPath(groupFolder: string): string {
  return path.join(CREDENTIALS_DIR, `${groupFolder}.json`);
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function jsonResponse(
  res: import('http').ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startGoogleProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });

  // Migrate existing credentials from groups/{name}/ to data/gws-credentials/
  migrateCredentials();

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/gws') {
          await handleGws(req, res);
        } else if (req.method === 'POST' && req.url === '/auth/exchange') {
          await handleAuthExchange(req, res, secrets);
        } else if (req.method === 'POST' && req.url === '/auth/disconnect') {
          await handleAuthDisconnect(req, res);
        } else if (
          req.method === 'GET' &&
          req.url?.startsWith('/auth/status')
        ) {
          handleAuthStatus(req, res);
        } else {
          jsonResponse(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'Google proxy error');
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: 'Internal server error' });
        }
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Google proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

async function handleGws(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { command, groupFolder, token } = body;

  if (!command || !groupFolder) {
    jsonResponse(res, 400, { error: 'Missing command or groupFolder' });
    return;
  }

  // Token verification: ensure the request comes from the right container
  const tokenGroup = validateToken(token);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    logger.warn(
      { groupFolder, tokenGroup },
      'Google proxy: token mismatch, request rejected',
    );
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const credPath = getCredentialsPath(groupFolder);
  if (!fs.existsSync(credPath)) {
    jsonResponse(res, 400, {
      error: 'Google not connected for this group. Use /connect-google first.',
    });
    return;
  }

  // Write credentials to a temp file for this invocation
  const tmpFile = path.join(
    os.tmpdir(),
    `gws-creds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
  fs.copyFileSync(credPath, tmpFile);

  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      exec(
        `${GWS_BIN} ${command}`,
        {
          timeout: GWS_TIMEOUT,
          env: {
            ...process.env,
            GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: tmpFile,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: err ? ((err as any).code ?? 1) : 0,
          });
        },
      );
    });

    // Update credentials file if gws refreshed the token
    // (gws writes updated tokens back to the credentials file)
    if (fs.existsSync(tmpFile)) {
      const tmpContent = fs.readFileSync(tmpFile, 'utf-8');
      const origContent = fs.readFileSync(credPath, 'utf-8');
      if (tmpContent !== origContent) {
        fs.copyFileSync(tmpFile, credPath);
      }
    }

    jsonResponse(res, 200, result);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

async function handleAuthExchange(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  secrets: Record<string, string>,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { code, groupFolder, token } = body;

  if (!code || !groupFolder) {
    jsonResponse(res, 400, { error: 'Missing code or groupFolder' });
    return;
  }

  const tokenGroup = validateToken(token);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const clientId = secrets.GOOGLE_CLIENT_ID;
  const clientSecret = secrets.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    jsonResponse(res, 500, {
      error: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured',
    });
    return;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: 'http://localhost:1',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    jsonResponse(res, 400, { error: `Token exchange failed: ${err}` });
    return;
  }

  const data = (await tokenRes.json()) as { refresh_token: string };
  const credentials = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: data.refresh_token,
    type: 'authorized_user',
  };

  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(
    getCredentialsPath(groupFolder),
    JSON.stringify(credentials, null, 2),
  );

  logger.info({ groupFolder }, 'Google credentials saved via proxy');
  jsonResponse(res, 200, { success: true });
}

async function handleAuthDisconnect(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { groupFolder, token } = body;

  const tokenGroup = validateToken(token);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!groupFolder) {
    jsonResponse(res, 400, { error: 'Missing groupFolder' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const credPath = getCredentialsPath(groupFolder);
  let revokeResult = '';

  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    if (creds.refresh_token) {
      const revokeRes = await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(creds.refresh_token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
      revokeResult = revokeRes.ok
        ? ' Token revoked at Google.'
        : ` Token revoke failed (${revokeRes.status}).`;
    }
  } catch {
    // No credentials file or parse error
  }

  try {
    fs.unlinkSync(credPath);
  } catch {
    /* ignore */
  }

  logger.info({ groupFolder, revokeResult }, 'Google credentials removed');
  jsonResponse(res, 200, { success: true, revokeResult });
}

function handleAuthStatus(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const groupFolder = url.searchParams.get('groupFolder') || '';
  const token = url.searchParams.get('token') || '';

  const tokenGroup = validateToken(token);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!groupFolder || !isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const connected = fs.existsSync(getCredentialsPath(groupFolder));
  jsonResponse(res, 200, { connected });
}

/**
 * Migrate credentials from groups/{name}/.gws-credentials.json
 * to data/gws-credentials/{name}.json (host-only location).
 */
function migrateCredentials(): void {
  const groupsDir = path.join(process.cwd(), 'groups');
  if (!fs.existsSync(groupsDir)) return;

  for (const folder of fs.readdirSync(groupsDir)) {
    const oldPath = path.join(groupsDir, folder, '.gws-credentials.json');
    const newPath = getCredentialsPath(folder);

    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try {
        fs.copyFileSync(oldPath, newPath);
        logger.info(
          { folder },
          'Migrated Google credentials to host-only location',
        );
      } catch (err) {
        logger.warn({ folder, err }, 'Failed to migrate Google credentials');
      }
    }
  }
}
