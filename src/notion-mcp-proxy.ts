/**
 * Notion MCP proxy for container isolation.
 * Manages @notionhq/notion-mcp-server processes on the host.
 * Containers connect via notion-mcp-wrapper.js which bridges stdio ↔ HTTP/SSE.
 * The proxy reads Notion credentials so containers never see the token.
 *
 * Endpoints:
 *   POST /notion/connect     - Validate and save Notion API token for a group
 *   POST /notion/disconnect  - Delete credentials for a group
 *   GET  /notion/status      - Check if credentials exist for a group
 *   GET  /notion/mcp/sse     - SSE stream: MCP server stdout → wrapper stdin
 *   POST /notion/mcp/message - Send message: wrapper stdout → MCP server stdin
 */
import { ChildProcess, spawn } from 'child_process';
import { createServer, Server } from 'http';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { validateToken, readBody, jsonResponse } from './proxy-server.js';

const NOTION_CREDENTIALS_DIR = path.join(DATA_DIR, 'notion-credentials');

function getCredentialsPath(groupFolder: string): string {
  return path.join(NOTION_CREDENTIALS_DIR, `${groupFolder}.json`);
}

// Active MCP sessions: proxy-token → running MCP process + SSE response
// One process per container session, cleaned up when SSE disconnects.
interface McpSession {
  process: ChildProcess;
  sseResponse: import('http').ServerResponse;
}
const mcpSessions = new Map<string, McpSession>();

export function startNotionMcpProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  fs.mkdirSync(NOTION_CREDENTIALS_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/notion/connect') {
          await handleNotionConnect(req, res);
        } else if (req.method === 'POST' && req.url === '/notion/disconnect') {
          await handleNotionDisconnect(req, res);
        } else if (req.method === 'POST' && req.url === '/notion/status') {
          await handleNotionStatus(req, res);
        } else if (req.method === 'POST' && req.url === '/notion/mcp/sse') {
          await handleMcpSse(req, res);
        } else if (
          req.method === 'POST' &&
          req.url?.startsWith('/notion/mcp/message')
        ) {
          await handleMcpMessage(req, res);
        } else {
          jsonResponse(res, 404, { error: 'Not found' });
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'Notion MCP proxy error');
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: 'Internal server error' });
        }
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Notion MCP proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

async function handleNotionConnect(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body: { token?: string; groupFolder?: string; proxyToken?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { token, groupFolder, proxyToken } = body;

  if (!token || !groupFolder) {
    jsonResponse(res, 400, { error: 'Missing token or groupFolder' });
    return;
  }

  const tokenGroup = validateToken(proxyToken);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  // Validate token against Notion API before saving
  const notionRes = await fetch('https://api.notion.com/v1/users/me', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  });

  if (!notionRes.ok) {
    logger.warn(
      { groupFolder, status: notionRes.status },
      'Notion token validation failed',
    );
    jsonResponse(res, 400, { error: 'Invalid or expired Notion token' });
    return;
  }

  const user = (await notionRes.json()) as { name?: string; type?: string };

  fs.mkdirSync(NOTION_CREDENTIALS_DIR, { recursive: true });
  const credFd = fs.openSync(getCredentialsPath(groupFolder), 'w', 0o600);
  try {
    fs.writeFileSync(credFd, JSON.stringify({ token }, null, 2));
  } finally {
    fs.closeSync(credFd);
  }

  logger.info({ groupFolder }, 'Notion credentials saved via proxy');
  jsonResponse(res, 200, { success: true, name: user.name, type: user.type });
}

async function handleNotionDisconnect(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body: { groupFolder?: string; proxyToken?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { groupFolder, proxyToken } = body;

  if (!groupFolder) {
    jsonResponse(res, 400, { error: 'Missing groupFolder' });
    return;
  }

  const tokenGroup = validateToken(proxyToken);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  try {
    fs.unlinkSync(getCredentialsPath(groupFolder));
  } catch {
    /* ignore — credentials may not exist */
  }

  logger.info({ groupFolder }, 'Notion credentials removed');
  jsonResponse(res, 200, { success: true });
}

async function handleNotionStatus(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body: { groupFolder?: string; proxyToken?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { groupFolder, proxyToken } = body;

  if (!groupFolder) {
    jsonResponse(res, 400, { error: 'Missing groupFolder' });
    return;
  }

  if (!isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const tokenGroup = validateToken(proxyToken);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  const connected = fs.existsSync(getCredentialsPath(groupFolder));
  jsonResponse(res, 200, { connected });
}

async function handleMcpSse(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  let body: { groupFolder?: string; proxyToken?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const { groupFolder = '', proxyToken = '' } = body;

  const tokenGroup = validateToken(proxyToken);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  if (!groupFolder || !isValidGroupFolder(groupFolder)) {
    jsonResponse(res, 400, { error: 'Invalid groupFolder' });
    return;
  }

  const credPath = getCredentialsPath(groupFolder);
  if (!fs.existsSync(credPath)) {
    jsonResponse(res, 400, {
      error: 'Notion not connected for this group. Use /connect-notion first.',
    });
    return;
  }

  let creds: { token: string };
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    jsonResponse(res, 500, { error: 'Failed to read Notion credentials' });
    return;
  }

  // Set up SSE response — flushHeaders() sends headers immediately without
  // waiting for the first data chunk, which is required for SSE connections.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Spawn @notionhq/notion-mcp-server on the host with the real token.
  // The container's wrapper bridges its stdio to this SSE stream.
  const mcpProcess = spawn('npx', ['-y', '@notionhq/notion-mcp-server'], {
    env: {
      ...process.env,
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${creds.token}`,
        'Notion-Version': '2022-06-28',
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Keyed by proxy token — unique per container session
  mcpSessions.set(proxyToken, { process: mcpProcess, sseResponse: res });

  // Forward MCP server stdout → SSE stream to container wrapper
  mcpProcess.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        res.write(`data: ${line}\n\n`);
      }
    }
  });

  mcpProcess.stderr?.on('data', (chunk: Buffer) => {
    logger.debug(
      { groupFolder },
      `Notion MCP stderr: ${chunk.toString().trim()}`,
    );
  });

  mcpProcess.on('exit', (code) => {
    logger.info({ groupFolder, code }, 'Notion MCP process exited');
    mcpSessions.delete(proxyToken);
    if (!res.writableEnded) res.end();
  });

  // Clean up when wrapper disconnects from SSE.
  // res.on('close') is used instead of req.on('close') because for SSE connections
  // (which never call res.end()), the response 'close' event fires more reliably
  // when the client disconnects.
  res.on('close', () => {
    mcpSessions.delete(proxyToken);
    if (!mcpProcess.killed) mcpProcess.kill();
    logger.info({ groupFolder }, 'Notion MCP SSE disconnected, process killed');
  });
}

async function handleMcpMessage(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
): Promise<void> {
  // Token and groupFolder are passed as headers to keep the body as pure MCP data
  const proxyToken = (req.headers['x-proxy-token'] as string) || '';
  const groupFolder = (req.headers['x-group-folder'] as string) || '';

  const tokenGroup = validateToken(proxyToken);
  if (!tokenGroup || tokenGroup !== groupFolder) {
    jsonResponse(res, 403, { error: 'Unauthorized' });
    return;
  }

  const session = mcpSessions.get(proxyToken);
  if (!session) {
    jsonResponse(res, 404, {
      error: 'No active MCP session. Connect via SSE first.',
    });
    return;
  }

  const body = await readBody(req);
  session.process.stdin?.write(body + '\n');
  jsonResponse(res, 202, { accepted: true });
}
