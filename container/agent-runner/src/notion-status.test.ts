import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkNotionStatus } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkNotionStatus', () => {
  it('POST로 호출하고 proxyToken을 body에 넣는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await checkNotionStatus('http://localhost:3003', 'mytoken', 'mygroup');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/notion/status');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body.proxyToken).toBe('mytoken');
    expect(body.groupFolder).toBe('mygroup');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('connected: true면 true를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true }),
    }));

    const result = await checkNotionStatus('http://localhost:3003', 'token', 'group');
    expect(result).toBe(true);
  });

  it('connected: false면 false를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: false }),
    }));

    const result = await checkNotionStatus('http://localhost:3003', 'token', 'group');
    expect(result).toBe(false);
  });

  it('ok: false면 false를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
    }));

    const result = await checkNotionStatus('http://localhost:3003', 'token', 'group');
    expect(result).toBe(false);
  });

  it('네트워크 오류 시 false를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await checkNotionStatus('http://localhost:3003', 'token', 'group');
    expect(result).toBe(false);
  });
});
