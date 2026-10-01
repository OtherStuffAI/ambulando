export class FeedParser {
  constructor() { this.worker = new Worker(new URL('../worker/feed-normalize-worker.js', import.meta.url), { type: 'module' }); this.pending = new Map(); this.id = 0;
    this.worker.onmessage = ({ data }) => { const p = this.pending.get(data.id); if (!p) return; this.pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); };
    this.worker.onerror = () => this.dispose();
  }
  parse(text, format, privateSource) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, text, format, privateSource }); }); }
  dispose() { this.worker.terminate(); for (const p of this.pending.values()) p.reject(new Error('parser_disposed')); this.pending.clear(); }
}
