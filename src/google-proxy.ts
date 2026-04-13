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
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);
import { createServer, Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { validateToken, readBody, jsonResponse } from './proxy-server.js';

const CREDENTIALS_DIR = path.join(DATA_DIR, 'gws-credentials');
const GWS_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'gws');
const GWS_TIMEOUT = 60_000;

// Allowed top-level gws subcommands
const GWS_ALLOWED_SUBCOMMANDS = new Set([
  'gmail',
  'calendar',
  'drive',
  'contacts',
  'people',
  'sheets',
  'docs',
  'slides',
  'tasks',
  'admin',
]);

function getCredentialsPath(groupFolder: string): string {
  return path.join(CREDENTIALS_DIR, `${groupFolder}.json`);
}

export function startGoogleProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/gws') {
          await handleGws(req, res);
        } else if (req.method === 'POST' && req.url === '/auth/exchange') {
          await handleAuthExchange(req, res, secrets);
        } else if (req.method === 'POST' && req.url === '/auth/disconnect') {
          await handleAuthDisconnect(req, res);
        } else if (req.method === 'POST' && req.url === '/auth/status') {
          await handleAuthStatus(req, res);
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

/**
 * Common request validation for all POST handlers.
 * Checks groupFolder presence, validity, and proxy token in that order.
 * Returns groupFolder on success, null if a response has already been sent.
 */
function validateRequest(
  body: { groupFolder?: string; token?: string },
  res: import('http').ServerResponse,
): string | null {
  const { groupFolder, token } = body;

  if (!groupFolder) {
    jsonResponse(res, 400, { error: 'Missing groupFolder' });
    return null;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return null;
  }

  const tokenGroup = validateToken(token);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return null;
  }

  return groupFolder;
}

async function handleGws(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  const { argv } = body;

  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((a: unknown) => typeof a === 'string')
  ) {
    jsonResponse(res, 400, {
      error: 'Missing or invalid argv (must be a non-empty string array)',
    });
    return;
  }

  const groupFolder = validateRequest(body, res);
  if (!groupFolder) return;

  // Validate top-level subcommand
  const subcommand = argv[0].toLowerCase();
  if (!GWS_ALLOWED_SUBCOMMANDS.has(subcommand)) {
    jsonResponse(res, 400, {
      error: `Disallowed gws subcommand: ${subcommand}`,
    });
    return;
  }

  const credPath = getCredentialsPath(groupFolder);
  if (!fs.existsSync(credPath)) {
    jsonResponse(res, 400, {
      error: 'Google not connected for this group. Use /connect-google first.',
    });
    return;
  }

  // Write credentials to a temp file for this invocation.
  // crypto.randomBytes() instead of Math.random() — cryptographically secure,
  // prevents filename prediction attacks (symlink race, temp file hijacking).
  // 0o600 permission — owner read/write only, prevents other users/processes
  // on the same host from reading the OAuth refresh token.
  const tmpFile = path.join(
    os.tmpdir(),
    `gws-creds-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  const fd = fs.openSync(tmpFile, 'w', 0o600);
  try {
    fs.writeFileSync(fd, fs.readFileSync(credPath));
  } finally {
    fs.closeSync(fd);
  }

  try {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const out = await execFileAsync(GWS_BIN, argv, {
        timeout: GWS_TIMEOUT,
        env: { ...process.env, GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: tmpFile },
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
      });
      stdout = out.stdout || '';
      stderr = out.stderr || '';
    } catch (err: any) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      // timeout으로 강제 종료된 경우 exitCode 124 (Unix 관례)
      exitCode = err.killed ? 124 : (err.code ?? 1);
    }

    // gws가 token을 갱신한 경우 credential 파일을 업데이트한다.
    // (gws는 갱신된 token을 credentials 파일에 다시 씀)
    // 주의: 그룹 채팅에서 여러 사용자가 동시에 요청을 보내면 token rotate 타이밍이
    // 겹칠 경우 race condition이 발생할 수 있다. 현실적으로 확률이 낮고,
    // 발생하더라도 재인증으로 해결 가능하다. 1대1 채팅에서는 발생하지 않는다.
    if (fs.existsSync(tmpFile)) {
      const tmpContent = fs.readFileSync(tmpFile, 'utf-8');
      const origContent = fs.readFileSync(credPath, 'utf-8');
      if (tmpContent !== origContent) {
        fs.copyFileSync(tmpFile, credPath);
      }
    }

    jsonResponse(res, 200, { stdout, stderr, exitCode });
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
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  const { code } = body;

  if (!code) {
    jsonResponse(res, 400, { error: 'Missing code' });
    return;
  }

  const groupFolder = validateRequest(body, res);
  if (!groupFolder) return;

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
    const errText = await tokenRes.text();
    logger.warn({ groupFolder, status: tokenRes.status }, 'Google token exchange failed');
    jsonResponse(res, 400, { error: 'Token exchange failed' });
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
  const credFd = fs.openSync(getCredentialsPath(groupFolder), 'w', 0o600);
  try {
    fs.writeFileSync(credFd, JSON.stringify(credentials, null, 2));
  } finally {
    fs.closeSync(credFd);
  }

  logger.info({ groupFolder }, 'Google credentials saved via proxy');
  jsonResponse(res, 200, { success: true });
}

async function handleAuthDisconnect(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }
  const groupFolder = validateRequest(body, res);
  if (!groupFolder) return;

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

async function handleAuthStatus(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid JSON' });
  }

  const groupFolder = validateRequest(body, res);
  if (!groupFolder) return;

  const connected = fs.existsSync(getCredentialsPath(groupFolder));
  jsonResponse(res, 200, { connected });
}
