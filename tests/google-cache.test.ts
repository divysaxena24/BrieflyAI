import { describe, it, expect, vi } from 'vitest';
import { googleCache } from '@/lib/services/google-cache';

describe('GoogleCache', () => {
  it('sets and gets values per integration', () => {
    const store = googleCache.getIntegrationStore('int-1');
    store.set('key1', { a: 1 }, 1000);
    const v = store.get<{ a: number }>('key1');
    expect(v).toEqual({ a: 1 });
  });

  it('expires entries after ttl', async () => {
    const store = googleCache.getIntegrationStore('int-2');
    store.set('k', 123, 10);
    expect(store.get<number>('k')).toBe(123);
    // advance time using vi
    vi.useFakeTimers();
    vi.advanceTimersByTime(20);
    const v = store.get<number>('k');
    expect(v).toBeUndefined();
    vi.useRealTimers();
  });
});
