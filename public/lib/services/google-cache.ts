type CacheEntry<T> = { value: T; ttl: number; ts: number };

class GoogleCache {
  private store: Map<string, Map<string, CacheEntry<any>>> = new Map();

  getIntegrationStore(integrationId: string) {
    if (!this.store.has(integrationId)) this.store.set(integrationId, new Map());
    const map = this.store.get(integrationId)!;
    return {
      get: <T>(key: string): T | undefined => {
        const e = map.get(key);
        if (!e) return undefined;
        if (Date.now() - e.ts > e.ttl) {
          map.delete(key);
          return undefined;
        }
        return e.value as T;
      },
      set: <T>(key: string, value: T, ttl = 1000 * 60 * 5) => {
        map.set(key, { value, ttl, ts: Date.now() });
      },
      del: (key: string) => map.delete(key),
      clear: () => map.clear(),
    };
  }

  clearAll() {
    this.store.clear();
  }
}

export const googleCache = new GoogleCache();
export default googleCache;
