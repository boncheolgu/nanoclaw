import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

import {
  startGoogleProxy,
  issueProxyToken,
  revokeProxyToken,
} from './google-proxy.js';

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
    req.write(body);
    req.end();
  });
}

describe('google-proxy', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    fs.mkdirSync(path.join(tmpRoot, 'data', 'gws-credentials'), {
      recursive: true,
    });
    server = await startGoogleProxy(0);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    // Clean credential files but keep the dir structure for next test
    const credDir = path.join(tmpRoot, 'data', 'gws-credentials');
    if (fs.existsSync(credDir)) {
      for (const f of fs.readdirSync(credDir)) {
        fs.unlinkSync(path.join(credDir, f));
      }
    }
  });

  // --- Blocker 1: /gws shell injection prevention ---

  describe('/gws endpoint', () => {
    it('rejects raw command string (old API)', async () => {
      const token = issueProxyToken('testgroup');
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
      revokeProxyToken(token);
    });

    it('rejects non-array argv', async () => {
      const token = issueProxyToken('testgroup');
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
      revokeProxyToken(token);
    });

    it('rejects empty argv array', async () => {
      const token = issueProxyToken('testgroup');
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
      revokeProxyToken(token);
    });

    it('rejects argv with non-string elements', async () => {
      const token = issueProxyToken('testgroup');
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
      revokeProxyToken(token);
    });

    it('rejects disallowed subcommand', async () => {
      const token = issueProxyToken('testgroup');
      // Write dummy credentials so we get past the cred check
      const credPath = path.join(
        tmpRoot,
        'data',
        'gws-credentials',
        'testgroup.json',
      );
      fs.writeFileSync(credPath, '{}');

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
      revokeProxyToken(token);
    });

    it('shell metacharacters in argv do not cause shell execution', async () => {
      const token = issueProxyToken('testgroup');
      const credPath = path.join(
        tmpRoot,
        'data',
        'gws-credentials',
        'testgroup.json',
      );
      fs.writeFileSync(credPath, '{}');

      // This would be dangerous with exec() but safe with execFile(shell:false)
      // The command will fail because gws binary doesn't exist, but the point
      // is it doesn't execute via shell
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
      // With execFile(shell:false), the semicolon is passed as a literal
      // argument to gws, not interpreted by a shell. If gws is installed,
      // it will show an "unrecognized subcommand" error containing the
      // literal string — that's safe. The key assertion is that "pwned"
      // does NOT appear as its own line in stdout (which would mean shell
      // execution occurred).
      const stdoutLines = (data.stdout || '').split('\n').map((l: string) => l.trim());
      expect(stdoutLines).not.toContain('pwned');
      revokeProxyToken(token);
    });

    it('accepts valid structured argv', async () => {
      const token = issueProxyToken('testgroup');
      const credPath = path.join(
        tmpRoot,
        'data',
        'gws-credentials',
        'testgroup.json',
      );
      fs.writeFileSync(credPath, '{}');

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
      // The gws binary won't exist in test, so we expect a non-zero exit
      // or error, but not a 400 validation error
      expect(res.statusCode).toBe(200);
      revokeProxyToken(token);
    });
  });

});
