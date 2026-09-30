// Small in-memory guards: one message at a time per chat, duplicate updates, and message rate.
// Memory is enough for one Railway instance; move these to the database before scaling out.

export function createQueue() {
  const tails = new Map();
  return function enqueue(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function createDedupe({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const seen = new Map();
  return function isDuplicate(id) {
    const t = now();
    for (const [key, at] of seen) if (t - at > ttlMs) seen.delete(key);
    if (seen.has(id)) return true;
    seen.set(id, t);
    return false;
  };
}

export function createRateLimiter({ limit, windowMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}
