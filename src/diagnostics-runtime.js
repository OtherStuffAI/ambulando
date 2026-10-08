import { observeDiagnostics, isDiagnosticRequest } from './diagnostics-events.js';
import { sanitizeDiagnosticEvent, diagnosticAsset } from './diagnostics-schema.js';

export class DiagnosticsWorkerClient {
  constructor() { this.pending = new Map(); this.nextId = 1; this.worker = null; }
  call(method, key, ...args) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker/diagnostics-worker.js', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', ({ data }) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
      });
      this.worker.addEventListener('error', () => this.dispose());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Diagnostics storage timed out')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, key, args });
    });
  }
  dispose() {
    this.worker?.terminate(); this.worker = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Diagnostics storage unavailable')); }
    this.pending.clear();
  }
}

export class DiagnosticsCapture {
  constructor({ record, enabled, target = globalThis.window }) {
    this.record = record; this.enabled = enabled; this.target = target; this.cleanup = [];
  }
  emit(input) {
    if (!this.enabled()) return;
    const event = sanitizeDiagnosticEvent({ ...input, ts: Date.now() });
    if (event) this.record(event);
  }
  start() {
    if (this.cleanup.length || !this.target) return;
    const target = this.target;
    const listen = (name, callback) => { target.addEventListener(name, callback); this.cleanup.push(() => target.removeEventListener(name, callback)); };
    this.cleanup.push(observeDiagnostics(input => this.emit(input)));
    listen('error', event => this.emit({ source: 'browser', level: 'error', code: event.error ? 'exception' : 'resource', name: event.error?.name, stack: event.error?.stack,
      asset: diagnosticAsset(event.filename), line: event.lineno, column: event.colno, category: event.error ? 'exception' : 'unavailable' }));
    listen('unhandledrejection', event => this.emit({ source: 'browser', level: 'error', code: 'rejection', name: event.reason?.name, stack: event.reason?.stack }));
    listen('popstate', () => this.emit({ source: 'ui', code: 'navigation', operation: 'navigation' }));
    listen('hashchange', () => this.emit({ source: 'ui', code: 'navigation', operation: 'navigation' }));
    listen('click', event => {
      const label = event.target?.closest?.('button')?.getAttribute('aria-label');
      this.emit({ source: 'ui', code: 'interaction', operation: label === 'Close thread' ? 'thread-close' : undefined });
    });
    // Never inspect DOM text, values, attributes, console arguments or bodies.
    const originalConsole = target.console?.error;
    if (originalConsole) {
      const capture = this;
      const wrapped = function (...args) { capture.emit({ source: 'browser', level: 'error', code: 'console' }); return originalConsole.apply(this, args); };
      target.console.error = wrapped;
      this.cleanup.push(() => { if (target.console.error === wrapped) target.console.error = originalConsole; });
    }
    const originalFetch = target.fetch;
    if (originalFetch) {
      const capture = this;
      const wrapped = async function (input, init) {
        // The signed API records these at its owning operation boundary, also
        // covering native transport. Do not duplicate/promote an attempt here.
        if (isDiagnosticRequest(init)) return originalFetch.call(this, input, init);
        const scope = capture.enabled();
        const start = performance.now();
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        const route = typeof input === 'string' ? input : input?.url;
        try {
          const response = await originalFetch.call(this, input, init);
          if (scope && capture.enabled() === scope) capture.emit({ source: 'network', level: response.ok ? 'info' : 'error', code: 'request', route, method, status: response.status, durationMs: performance.now() - start });
          return response;
        } catch (error) {
          if (scope && capture.enabled() === scope) capture.emit({ source: 'network', level: 'error', code: 'request', route, method, status: 0, name: error?.name, durationMs: performance.now() - start });
          throw error;
        }
      };
      target.fetch = wrapped;
      this.cleanup.push(() => { if (target.fetch === wrapped) target.fetch = originalFetch; });
    }
    if (target.PerformanceObserver) {
      const observer = new target.PerformanceObserver(list => {
        for (const entry of list.getEntries()) this.emit({ source: 'network', code: 'resource', route: entry.name, asset: diagnosticAsset(entry.name), durationMs: entry.duration });
      });
      try { observer.observe({ type: 'resource', buffered: false }); this.cleanup.push(() => observer.disconnect()); } catch { observer.disconnect(); }
    }
  }
  stop() { for (const fn of this.cleanup.splice(0)) fn(); }
}
