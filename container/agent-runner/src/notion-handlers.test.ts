import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleNotionConnect,
  handleNotionStatus,
  handleNotionDisconnect,
} from './notion-handlers.js';

const ENV = {
  notionMcpUrl: 'http://localhost:3003',
  notionMcpToken: 'test-proxy-token',
  groupFolder: 'test-group',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// --- notion_connect ---
describe('handleNotionConnect', () => {
  it('프록시가 성공 응답을 반환하면 연결된 사용자 이름을 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, name: 'Test Bot', type: 'bot' }),
      }),
    );

    const result = await handleNotionConnect('ntn_test_token', ENV);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Test Bot');
    expect(result.content[0].text).toContain('bot');
  });

  it('올바른 URL과 body로 프록시에 요청을 보낸다', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, name: 'Bot', type: 'bot' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleNotionConnect('ntn_test_token', ENV);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3003/notion/connect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'ntn_test_token',
          groupFolder: 'test-group',
          proxyToken: 'test-proxy-token',
        }),
      }),
    );
  });

  it('프록시가 실패 응답을 반환하면 isError를 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Invalid Notion token' }),
      }),
    );

    const result = await handleNotionConnect('invalid_token', ENV);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid Notion token');
  });

  it('fetch가 throw하면 isError를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await handleNotionConnect('ntn_test_token', ENV);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });
});

// --- notion_status ---
describe('handleNotionStatus', () => {
  it('연결된 상태이면 Connected를 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ connected: true }),
      }),
    );

    const result = await handleNotionStatus(ENV);

    expect(result.content[0].text).toBe('Connected.');
  });

  it('연결되지 않은 상태이면 안내 메시지를 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ connected: false }),
      }),
    );

    const result = await handleNotionStatus(ENV);

    expect(result.content[0].text).toContain('Not connected');
  });

  it('올바른 URL과 body로 프록시에 요청을 보낸다', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleNotionStatus(ENV);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3003/notion/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          groupFolder: 'test-group',
          proxyToken: 'test-proxy-token',
        }),
      }),
    );
  });

  it('fetch가 throw하면 에러 메시지를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await handleNotionStatus(ENV);

    expect(result.content[0].text).toContain('Error checking status');
  });
});

// --- notion_disconnect ---
describe('handleNotionDisconnect', () => {
  it('성공 시 disconnected 메시지를 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    const result = await handleNotionDisconnect(ENV);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('disconnected');
  });

  it('올바른 URL과 body로 프록시에 요청을 보낸다', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handleNotionDisconnect(ENV);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3003/notion/disconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          groupFolder: 'test-group',
          proxyToken: 'test-proxy-token',
        }),
      }),
    );
  });

  it('fetch가 throw하면 isError를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await handleNotionDisconnect(ENV);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });
});
