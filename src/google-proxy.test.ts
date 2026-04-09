import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';

// vi.mock is hoisted — use vi.hoisted so tmpRoot is available in the factory
const { tmpRoot } = vi.hoisted(() => {
  const _fs = require('fs');
  const _path = require('path');
  const _os = require('os');
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'gproxy-test-'));
  return { tmpRoot: root as string };
});

vi.mock('./config.js', () => ({
  DATA_DIR: path.join(tmpRoot, 'data'),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
  })),
}));

vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn((f: string) => /^[A-Za-z0-9_-]+$/.test(f) && f !== 'global'),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startGoogleProxy } from './google-proxy.js';
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
): Promise<{ statusCode: number; body: string }> {
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

const CRED_DIR = path.join(tmpRoot, 'data', 'gws-credentials');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('google-proxy', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    issuedTokens = [];
    fs.mkdirSync(CRED_DIR, { recursive: true });
    server = await startGoogleProxy(0);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    issuedTokens.forEach(revokeProxyToken);
    issuedTokens = [];
    await new Promise<void>((r) => server?.close(() => r()));
    // Clean credential files but keep the dir structure for next test
    if (fs.existsSync(CRED_DIR)) {
      for (const f of fs.readdirSync(CRED_DIR)) {
        fs.unlinkSync(path.join(CRED_DIR, f));
      }
    }
  });

  // --- /gws shell injection prevention ---
  describe('/gws endpoint', () => {
    it('rejects raw command string (old API)', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          command: 'gmail +triage',
          groupFolder: 'testgroup',
          token,
        }),
      );
      const data = JSON.parse(res.body);
      expect(res.statusCode).toBe(400);
      expect(data.error).toMatch(/argv/i);
    });

    it('rejects non-array argv', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          argv: 'gmail +triage',
          groupFolder: 'testgroup',
          token,
        }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects empty argv array', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ argv: [], groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects argv with non-string elements', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          argv: ['gmail', 123],
          groupFolder: 'testgroup',
          token,
        }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects disallowed subcommand', async () => {
      const token = issueToken('testgroup');
      fs.writeFileSync(path.join(CRED_DIR, 'testgroup.json'), '{}');

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          argv: ['exec', 'rm', '-rf', '/'],
          groupFolder: 'testgroup',
          token,
        }),
      );
      const data = JSON.parse(res.body);
      expect(res.statusCode).toBe(400);
      expect(data.error).toMatch(/disallowed/i);
    });

    it('shell metacharacters in argv do not cause shell execution', async () => {
      const token = issueToken('testgroup');
      fs.writeFileSync(path.join(CRED_DIR, 'testgroup.json'), '{}');

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          argv: ['gmail', '; echo pwned'],
          groupFolder: 'testgroup',
          token,
        }),
      );
      const data = JSON.parse(res.body);
      const stdoutLines = (data.stdout || '').split('\n').map((l: string) => l.trim());
      expect(stdoutLines).not.toContain('pwned');
    });

    it('accepts valid structured argv', async () => {
      const token = issueToken('testgroup');
      fs.writeFileSync(path.join(CRED_DIR, 'testgroup.json'), '{}');

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/gws',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          argv: ['gmail', '+triage'],
          groupFolder: 'testgroup',
          token,
        }),
      );
      expect(res.statusCode).toBe(200);
    });
  });

  // --- /auth/exchange ---
  describe('/auth/exchange', () => {
    it('code 없으면 400을 반환한다', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/exchange', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('token 불일치 시 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/exchange', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ code: 'auth_code', groupFolder: 'testgroup', token: 'invalid' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('Google token API 실패 시 400을 반환한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'invalid_grant',
      }));
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/exchange', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ code: 'bad_code', groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Token exchange failed');
    });

    it('성공 시 Google OAuth API에 올바른 파라미터를 전송하고 credential 파일을 생성한다', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ refresh_token: 'rtoken_123' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/exchange', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ code: 'valid_code', groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);

      // Google OAuth token API에 올바른 요청을 보냈는지 검증
      const tokenCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('oauth2.googleapis.com/token'),
      );
      expect(tokenCall).toBeDefined();
      const body = new URLSearchParams(tokenCall![1].body as string);
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
      expect(body.get('code')).toBe('valid_code');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('redirect_uri')).toBe('http://localhost:1');

      // credential 파일 생성 및 내용 검증
      const credFile = path.join(CRED_DIR, 'testgroup.json');
      expect(fs.existsSync(credFile)).toBe(true);
      const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
      expect(creds.refresh_token).toBe('rtoken_123');
      expect(creds.client_id).toBe('test-client-id');
      expect(creds.client_secret).toBe('test-client-secret');
    });
  });

  // --- /auth/disconnect ---
  describe('/auth/disconnect', () => {
    it('token 불일치 시 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token: 'invalid' }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('credential 파일이 있으면 Google에 revoke 후 파일을 삭제한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const credFile = path.join(CRED_DIR, 'testgroup.json');
      fs.writeFileSync(credFile, JSON.stringify({
        refresh_token: 'rtoken_to_revoke',
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
      }));

      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(credFile)).toBe(false);

      // Google revoke API가 올바른 token으로 호출됐는지 검증
      const fetchMock = vi.mocked(fetch);
      const revokeCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('revoke')
      );
      expect(revokeCall).toBeDefined();
      expect(String(revokeCall![0])).toContain('rtoken_to_revoke');
    });

    it('파일 없어도 에러 없이 200을 반환한다', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);
    });

    it('Google revoke 실패해도 파일은 삭제하고 200을 반환한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
      const credFile = path.join(CRED_DIR, 'testgroup.json');
      fs.writeFileSync(credFile, JSON.stringify({ refresh_token: 'rtoken' }));

      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/disconnect', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(credFile)).toBe(false);
    });
  });

  // --- /auth/status ---
  describe('/auth/status', () => {
    it('credential 파일 있으면 connected: true를 반환한다', async () => {
      fs.writeFileSync(path.join(CRED_DIR, 'testgroup.json'), '{}');
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connected).toBe(true);
    });

    it('credential 파일 없으면 connected: false를 반환한다', async () => {
      const token = issueToken('testgroup');
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token }),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).connected).toBe(false);
    });

    it('token 불일치 시 403을 반환한다', async () => {
      const res = await makeRequest(
        port,
        { method: 'POST', path: '/auth/status', headers: { 'content-type': 'application/json' } },
        JSON.stringify({ groupFolder: 'testgroup', token: 'invalid' }),
      );
      expect(res.statusCode).toBe(403);
    });
  });
});
