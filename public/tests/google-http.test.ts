import { describe, it, expect, vi } from 'vitest';
import { safeFetch } from '@/lib/services/google-http';

describe('GoogleHTTP safeFetch', () => {
  it('retries on transient status and eventually succeeds', async () => {
    const responses = [
      { ok: false, status: 500, json: async () => ({}) },
      { ok: true, status: 200, json: async () => ({ ok: true }) },
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
    (global as any).fetch = fetchMock;

    const res = await safeFetch('https://example.com', { method: 'GET' }, { url: '/test' }, 1000, 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('retries on AbortError (timeout) then rethrows after exhausting retries', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'AbortError' })))
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('timed out 2'), { name: 'AbortError' })));
    (global as any).fetch = fetchMock;

    await expect(safeFetch('https://example.com', { method: 'GET' }, { url: '/test' }, 1000, 1)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNRESET and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('conn reset'), { code: 'ECONNRESET' })))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    (global as any).fetch = fetchMock;

    const res = await safeFetch('https://example.com', { method: 'GET' }, { url: '/test' }, 1000, 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
});
