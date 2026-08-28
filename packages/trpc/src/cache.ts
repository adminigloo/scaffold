export interface RequestCache<T> {
  /**
   * Return the cached lookup for `key`, starting it with `factory` if this is
   * the first caller.
   */
  get(key: string, factory: () => Promise<T>): Promise<T>;
}

/**
 * Memoise async lookups for the lifetime of one request.
 *
 * askLou resolved the caller's access row ~60 times for a single request — one
 * `forecastCFF` call fanning out to ten `forecastBS` calls fanning out to five
 * `forecastIS` calls, each router hop re-reading the same row. One lookup would
 * have done. Nothing was wrong with any individual query; the cost only exists
 * because the hops could not see each other.
 *
 * Two properties make the difference between this and a plain `Map`:
 *
 *   1. It caches the PROMISE, not the resolved value. Router hops run
 *      concurrently — `Promise.all` over ten children starts ten lookups before
 *      the first one settles, so a cache that only stores settled values
 *      catches none of them and the stampede survives intact.
 *   2. It EVICTS on rejection. A cached rejected promise would hand the same
 *      failure to every later caller, so one transient database blip during the
 *      first permission lookup would pin a FORBIDDEN on the rest of the
 *      request and read to the user like a permissions bug.
 *
 * Per request, never module-level: a process-wide cache keyed by user id
 * outlives the request that populated it, and a permission change would not
 * take effect until the process restarted.
 */
export function createRequestCache<T>(): RequestCache<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    get(key, factory) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      const pending = factory();
      inFlight.set(key, pending);

      // Attached here, at insertion time, rather than in the `catch` of some
      // eventual awaiter. A caller may fire this off and never await it (the
      // cache exists precisely so later hops can reuse the promise), and an
      // unhandled rejection takes the whole Node process down under the
      // default `--unhandled-rejections=throw`.
      pending.catch(() => {
        // Only evict our own entry. A retry may already have replaced it, and
        // deleting unconditionally would throw away a live, healthy lookup.
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });

      return pending;
    },
  };
}
