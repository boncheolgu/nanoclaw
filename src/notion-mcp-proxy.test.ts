import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';

const { tmpRoot } = vi.hoisted(() => {
  const _fs = require('fs');
  const _path = require('path');
  const _os = require('os');
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'notion-proxy-test-'));
  return { tmpRoot: root as string };
});

vi.mock('./config.js', () => ({
  DATA_DIR: path.join(tmpRoot, 'data'),
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(
    (f: string) => /^[A-Za-z0-9_-]+$/.test(f) && f !== 'global',
  ),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// spawn mock — fake MCP process
function createFakeMcpProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc.killed = false;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeMcpProcess>;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { startNotionMcpProxy } from './notion-mcp-proxy.js';
import { issueProxyToken, revokeProxyToken } from './proxy-server.js';

// token 추적 — assertion 실패 시에도 afterEach에서 cleanup 보장
let issuedTokens: string[] = [];
function issueToken(groupFolder: string): string {
  const token = issueProxyToken(groupFolder);
  issuedTokens.push(token);
  return token;
}

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    // 응답 없으면 3초 후 명시적으로 실패
    req.setTimeout(3000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

const CRED_DIR = path.join(tmpRoot, 'data', 'notion-credentials');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('notion-mcp-proxy', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    fakeProc = createFakeMcpProcess();
    issuedTokens = [];
    fs.mkdirSync(CRED_DIR, { recursive: true });
    server = await startNotionMcpProxy(0);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // assertion 실패 시에도 token 정리 보장
    issuedTokens.forEach(revokeProxyToken);
    issuedTokens = [];
    await new Promise<void>((r) => {
      (server as any).closeAllConnections?.();
      server?.close(() => r());
    });
    for (const f of fs.readdirSync(CRED_DIR)) {
      fs.unlinkSync(path.join(CRED_DIR, f));
    }
  });

  // --- /notion/connect ---
  describe('/notion/connect', () => {
    it('token 없으면 400을 반환한다', async () => {
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/connect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('token 불일치 시 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/connect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ token: 'ntn_test', groupFolder: 'testgroup', proxyToken: 'invalid' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('Notion API가 실패하면 400을 반환한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'Unauthorized',
      }));
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/connect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ token: 'ntn_invalid', groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('성공 시 credential 파일을 생성하고 200을 반환한다', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'Test Bot', type: 'bot' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/connect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ token: 'ntn_valid', groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(200);

      // Notion API가 올바른 token으로 호출됐는지 검증
      const notionCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('notion.com'),
      );
      expect(notionCall).toBeDefined();
      expect(notionCall![1].headers.Authorization).toContain('ntn_valid');

      // credential 파일 생성 및 내용 검증
      const credFile = path.join(CRED_DIR, 'testgroup.json');
      expect(fs.existsSync(credFile)).toBe(true);
      const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
      expect(creds.token).toBe('ntn_valid');
    });
  });

  // --- /notion/disconnect ---
  describe('/notion/disconnect', () => {
    it('연결된 상태에서 disconnect 시 credential 파일을 삭제한다', async () => {
      const credFile = path.join(CRED_DIR, 'testgroup.json');
      fs.writeFileSync(credFile, JSON.stringify({ token: 'ntn_test' }));

      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(credFile)).toBe(false);
    });

    it('파일 없어도 에러 없이 200을 반환한다', async () => {
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(200);
    });
  });

  // --- /notion/status ---
  describe('/notion/status', () => {
    it('파일 있으면 connected: true를 반환한다', async () => {
      fs.writeFileSync(
        path.join(CRED_DIR, 'testgroup.json'),
        JSON.stringify({ token: 'ntn_test' }),
      );
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connected).toBe(true);
    });

    it('파일 없으면 connected: false를 반환한다', async () => {
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connected).toBe(false);
    });

    it('token 불일치 시 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken: 'invalid' }),
      );
      expect(res.statusCode).toBe(403);
    });
  });

  // --- /notion/mcp/sse ---
  describe('/notion/mcp/sse', () => {
    it('credentials 없으면 400을 반환한다', async () => {
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/notion/mcp/sse', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', proxyToken }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('credentials 있으면 SSE 헤더로 응답하고 MCP 프로세스를 spawn한다', async () => {
      const { spawn } = await import('child_process');
      fs.writeFileSync(
        path.join(CRED_DIR, 'testgroup.json'),
        JSON.stringify({ token: 'ntn_real' }),
      );
      const proxyToken = issueToken('testgroup');

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/notion/mcp/sse',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(spawn).toHaveBeenCalledWith(
              'npx',
              ['-y', '@notionhq/notion-mcp-server'],
              expect.objectContaining({
                env: expect.objectContaining({
                  OPENAPI_MCP_HEADERS: expect.stringContaining('ntn_real'),
                }),
              }),
            );
            res.destroy();
            resolve();
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ groupFolder: 'testgroup', proxyToken }));
        req.end();
      });
    });

    it('SSE 연결이 끊기면 MCP 프로세스를 kill한다', async () => {
      fs.writeFileSync(
        path.join(CRED_DIR, 'testgroup.json'),
        JSON.stringify({ token: 'ntn_real' }),
      );
      const proxyToken = issueToken('testgroup');

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/notion/mcp/sse',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ groupFolder: 'testgroup', proxyToken }));
        req.end();
      });

      // 서버에서 모든 연결 강제 종료 → res.on('close') 핸들러 발동
      (server as any).closeAllConnections?.();
      // kill 호출될 때까지 이벤트 기반 대기 (setTimeout(100) 제거)
      await vi.waitFor(() => expect(fakeProc.kill).toHaveBeenCalled(), { timeout: 2000 });
    });
  });

  // --- /notion/mcp/message ---
  describe('/notion/mcp/message', () => {
    it('활성 세션 없으면 404를 반환한다', async () => {
      const proxyToken = issueToken('testgroup');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/notion/mcp/message',
          headers: {
            'content-type': 'application/json',
            'x-proxy-token': proxyToken,
            'x-group-folder': 'testgroup',
          },
        },
        JSON.stringify({ method: 'tools/list' }),
      );
      expect(res.statusCode).toBe(404);
    });

    it('잘못된 x-proxy-token이면 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/notion/mcp/message',
          headers: {
            'content-type': 'application/json',
            'x-proxy-token': 'invalid-token',
            'x-group-folder': 'testgroup',
          },
        },
        JSON.stringify({ method: 'tools/list' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('헤더 누락이면 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/notion/mcp/message',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ method: 'tools/list' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('다른 그룹의 token으로 접근하면 403을 반환한다', async () => {
      const proxyToken = issueToken('group-a');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/notion/mcp/message',
          headers: {
            'content-type': 'application/json',
            'x-proxy-token': proxyToken,
            'x-group-folder': 'group-b',  // 다른 그룹
          },
        },
        JSON.stringify({ method: 'tools/list' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('활성 세션 있으면 MCP 프로세스 stdin에 메시지를 전달하고 202를 반환한다', async () => {
      fs.writeFileSync(
        path.join(CRED_DIR, 'testgroup.json'),
        JSON.stringify({ token: 'ntn_real' }),
      );
      const proxyToken = issueToken('testgroup');
      const stdinData: string[] = [];
      fakeProc.stdin.on('data', (d) => stdinData.push(d.toString()));

      // SSE 연결을 유지한 채로 message 전송 — 닫으면 세션이 삭제됨
      let sseRes: http.IncomingMessage;
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/notion/mcp/sse',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            sseRes = res;
            res.resume();
            resolve();
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ groupFolder: 'testgroup', proxyToken }));
        req.end();
      });

      const mcpMessage = JSON.stringify({ method: 'tools/list', id: 1 });
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/notion/mcp/message',
          headers: {
            'content-type': 'application/json',
            'x-proxy-token': proxyToken,
            'x-group-folder': 'testgroup',
          },
        },
        mcpMessage,
      );

      expect(res.statusCode).toBe(202);
      // stdin에 전달된 데이터가 유효한 JSON이고 method가 올바른지 검증
      const received = JSON.parse(stdinData.join('').trim());
      expect(received.method).toBe('tools/list');
      expect(received.id).toBe(1);

      sseRes!.socket?.destroy();
    });
  });
});
