import { FEED_LIMITS, nextFeedUrl } from './normalize.js';
import { feedRowKey, feedSourceKey, purgePrivateFeedBodies } from './store.js';
export async function boundedFeedText(response, signal) {
  if (Number(response.headers.get('content-length')) > FEED_LIMITS.bytes) throw new Error('feed_too_large');
  const reader = response.body?.getReader(); if (!reader) throw new Error('feed_body_required');
  const chunks = []; let bytes = 0;
  try { while (true) { signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > FEED_LIMITS.bytes) throw new Error('feed_too_large'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const all = new Uint8Array(bytes); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}
export class FeedSourceService {
  constructor({ db, context, resolve, parse, fetchImpl = fetch, now = Date.now, random = Math.random }) {
    Object.assign(this, { db, context, resolve, parse, fetchImpl, now, random }); this.sources = new Map(); this.queue = []; this.running = 0; this.disposed = false; this.timer = null;
  }
  async update(subscriptions) {
    if (this.disposed) return;
    const active = new Map(subscriptions.filter(s => s.status === 'active').map(s => [s.id, s]));
    for (const [id, entry] of this.sources) {
      if (!active.has(id) || feedSourceKey(active.get(id).source) !== feedSourceKey(entry.subscription.source)) { entry.generation++; entry.controller?.abort(); this.sources.delete(id); await purgePrivateFeedBodies(this.db, this.context, id); const key = feedRowKey(this.context, id); const status = await this.db.feed_source_status.get(key); if (status) await this.db.feed_source_status.put({ ...status, title: '', stale: true }); }
    }
    for (const [id, s] of active) { const existing = this.sources.get(id); if (existing) existing.subscription = s; else this.sources.set(id, { subscription: s, generation: 0, next: 0, failures: 0, denied: false }); }
    this.tick();
  }
  tick() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    if (!this.sources.size) return;
    for (const [id, e] of this.sources) if (!e.denied && !e.pending && e.next <= this.now()) void this.refresh(id);
    // Private body retention is bounded to ten minutes even during outages.
    void this.db.feed_items.where('context').equals(this.context).filter(r => r.private && r.fetched_at < this.now() - 600000).delete().catch(() => {});
    this.timer = setTimeout(() => this.tick(), 30000);
  }
  refresh(id, { revalidate = false } = {}) {
    const e = this.sources.get(id); if (this.disposed || !e) return Promise.resolve(); if (e.pending) return e.pending;
    if (e.denied && !revalidate) return Promise.resolve();
    e.denied = false;
    e.pending = new Promise((resolve, reject) => { this.queue.push({ e, resolve, reject }); this.drain(); });
    e.pending.catch(() => {}).finally(() => { e.pending = null; }); return e.pending;
  }
  drain() {
    while (!this.disposed && this.running < FEED_LIMITS.concurrency && this.queue.length) {
      const job = this.queue.shift(); this.running++;
      this.run(job.e).then(job.resolve, job.reject).finally(() => { this.running--; this.drain(); });
    }
  }
  async revoke(id) { const e = this.sources.get(id); if (e) { e.denied = true; e.generation++; e.controller?.abort(); } await purgePrivateFeedBodies(this.db, this.context, id); const key = feedRowKey(this.context, id); const status = await this.db.feed_source_status.get(key); if (status) await this.db.feed_source_status.put({ ...status, title: '', stale: true }); }
  async run(e) {
    const sub = e.subscription, gen = ++e.generation, controller = new AbortController(); e.controller = controller;
    const current = () => { if (this.disposed || e.generation !== gen || this.sources.get(sub.id) !== e || e.denied) throw new Error('feed_disposed'); controller.signal.throwIfAborted(); };
    const key = feedRowKey(this.context, sub.id), previous = await this.db.feed_source_status.get(key);
    const status = { ...previous, key, context: this.context, subscription_id: sub.id, last_attempt: this.now(), stale: true };
    try {
      const resolutionTimer = setTimeout(() => controller.abort(new Error('feed_timeout')), FEED_LIMITS.timeout);
      let binding; try { binding = await this.resolve(sub, controller.signal); } finally { clearTimeout(resolutionTimer); } current();
      let page = binding.url; const visited = new Set(), items = new Map();
      for (let n = 0; page && n < FEED_LIMITS.pages; n++) {
        current(); if (visited.has(page)) throw new Error('pagination_loop'); visited.add(page);
        const timer = setTimeout(() => controller.abort(new Error('feed_timeout')), FEED_LIMITS.timeout);
        try {
          const headers = sub.source.kind === 'wapp' ? await binding.headers(page, controller.signal) : {};
          current(); const response = await (binding.fetchImpl || this.fetchImpl)(page, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors', signal: controller.signal });
          if (!response.ok) { const error = new Error(`feed_http_${response.status}`); error.status = response.status; const retry = Number(response.headers.get('retry-after')); error.retryAfter = Number.isFinite(retry) ? Math.min(FEED_LIMITS.backoff, Math.max(0, retry * 1000)) : 0; throw error; }
          const type = response.headers.get('content-type') || '';
          if (!(sub.source.format === 'rss' ? /xml|rss/i : /json/i).test(type)) throw new Error('unsupported_content_type');
          const text = await boundedFeedText(response, controller.signal); current();
          const normalized = await this.parse(text, sub.source.format, sub.source.kind === 'wapp'); current();
          for (const item of normalized.items) { items.set(item.id, item); if (items.size > FEED_LIMITS.items) throw new Error('feed_too_large'); }
          status.title = normalized.title; page = normalized.next_url ? nextFeedUrl(normalized.next_url, binding.url, sub.source.kind === 'wapp') : '';
          status.bounded = Boolean(page && n + 1 === FEED_LIMITS.pages);
        } finally { clearTimeout(timer); }
      }
      await this.db.transaction('rw', this.db.feed_items, this.db.feed_source_status, this.db.feed_subscriptions, async () => {
        current(); const storedSub = await this.db.feed_subscriptions.get(feedRowKey(this.context, sub.id));
        if (storedSub && storedSub.status !== 'active') throw new Error('feed_disposed');
        if (items.size) await this.db.feed_items.bulkPut([...items.values()].map(item => ({ ...item, key: feedRowKey(this.context, sub.id, item.id), context: this.context, subscription_id: sub.id, source_key: feedSourceKey(sub.source), private: sub.source.kind === 'wapp', source_title: status.title, fetched_at: this.now() })));
        const cached = await this.db.feed_items.where('context').equals(this.context).filter(r => r.subscription_id === sub.id).toArray();
        cached.sort((a, b) => String(b.published).localeCompare(String(a.published)) || a.key.localeCompare(b.key));
        if (cached.length > FEED_LIMITS.items) await this.db.feed_items.bulkDelete(cached.slice(FEED_LIMITS.items).map(r => r.key));
        current(); await this.db.feed_source_status.put({ ...status, last_success: this.now(), stale: false, error: '', retry_at: 0 });
      });
      e.failures = 0; e.next = this.now() + FEED_LIMITS.poll * (0.9 + this.random() * 0.2);
    } catch (error) {
      if (this.disposed || e.generation !== gen || this.sources.get(sub.id) !== e) return;
      if ([401, 403, 404].includes(error.status) || ['registry_revoked', 'unsupported_source_transport'].includes(error.message) || error.name === 'NotAllowedError' || /No Nostr session|No secret key|pubkey.*match|signer.*locked/i.test(error.message)) { await this.revoke(sub.id); status.title = ''; }
      e.failures++; e.next = this.now() + Math.max(error.retryAfter || 0, Math.min(FEED_LIMITS.backoff, 5000 * 2 ** Math.min(10, e.failures - 1) * (0.9 + this.random() * 0.2)));
      await this.db.feed_source_status.put({ ...status, error: error instanceof TypeError ? 'Direct source unavailable; it may not allow CORS.' : (/^[a-z0-9_]+$/.test(error.message) ? error.message : 'source_unavailable'), retry_at: e.denied ? 0 : e.next });
      throw error;
    } finally { if (e.controller === controller) e.controller = null; }
  }
  async dispose() {
    this.disposed = true; clearTimeout(this.timer); for (const e of this.sources.values()) { e.generation++; e.controller?.abort(); }
    for (const job of this.queue.splice(0)) job.resolve(); this.sources.clear();
    await purgePrivateFeedBodies(this.db, this.context);
  }
}
