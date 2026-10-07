export const DIAGNOSTICS_VERSION = 1;
export const DIAGNOSTICS_WINDOW_MS = 30 * 60_000;
export const DIAGNOSTICS_EVENT_LIMIT = 2_000;
export const DIAGNOSTICS_BYTE_LIMIT = 512 * 1024;
export const DIAGNOSTICS_QUEUE_BYTES = 2 * 1024 * 1024;
export const DIAGNOSTICS_QUEUE_TTL = 24 * 60 * 60_000;
export const DIAGNOSTICS_AFTERMATH_MS = 15_000;

const sources = new Set(['browser', 'worker', 'network', 'ui', 'host']);
const levels = new Set(['trace', 'debug', 'info', 'warn', 'error']);
const codes = new Set(['console', 'exception', 'rejection', 'sync', 'worker', 'request',
  'resource', 'navigation', 'interaction', 'lifecycle', 'transport', 'webview', 'recovery']);
const operations = new Set(['sync', 'startup-sync', 'sse', 'storage', 'workspace-key', 'message-timing', 'worker-failure', 'report-open', 'report-send', 'thread-close', 'navigation']);
const errorCodes = new Set(['pg_read_authority_changed', 'pg_read_authority_resetting', 'worker_unavailable', 'storage_unavailable']);
const assetPattern = '(?:index|diagnostics-worker|sync-worker|tower-pg-materialization-worker|tiptap-editor-adapter|task-description-editor|pg-record-delta|pg-device-checkpoints)-[A-Za-z0-9_-]{8,16}\\.js';
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'AbortError', 'NetworkError', 'TransactionInactiveError', 'SecurityError']);
const routeParts = new Set(['api', 'v4', 'flightdeck-pg', 'workspaces', 'channels', 'threads',
  'messages', 'tasks', 'docs', 'body', 'comments', 'files', 'storage', 'prepare', 'complete',
  'download-url', 'sync', 'events', 'stream', 'members', 'groups', 'scopes', 'bundles',
  'updates', 'health', 'assets', 'index.html', 'version.json']);

export function diagnosticRoute(value) {
  try {
    const path = new URL(String(value), 'https://diagnostics.invalid').pathname;
    return '/' + path.split('/').filter(Boolean).slice(0, 12)
      .map(part => routeParts.has(part) ? part : ':id').join('/');
  } catch { return '/:unknown'; }
}

export function diagnosticStack(stack) {
  // Retain only approved built chunk basenames and numeric locations. Unknown
  // filenames, function names and the error's message line are never retained.
  const text = String(stack || '');
  const safeFrame = new RegExp(`^at (?:<frame>|${assetPattern}):\\d{1,7}:\\d{1,7}$`);
  return text.split('\n').slice(0, 9).flatMap(line => {
    if (safeFrame.test(line)) return [line];
    const match = line.match(/(?:https?:\/\/|file:\/\/|\/)[^\s)]*?:(\d{1,7}):(\d{1,7})\)?\s*$/);
    if (!match) return [];
    const approved = line.match(new RegExp(`(?:/|^)(${assetPattern})(?:\\?[^\\s)]*)?:\\d{1,7}:\\d{1,7}\\)?$`));
    return [`at ${approved?.[1] || '<frame>'}:${match[1]}:${match[2]}`];
  }).slice(0, 8).join('\n');
}

export function sanitizeDiagnosticEvent(input = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const ts = Number(input.ts);
  if (!Number.isFinite(ts) || ts < now - DIAGNOSTICS_WINDOW_MS || ts > now + 5_000) return null;
  const event = { ts, source: sources.has(input.source) ? input.source : 'browser',
    level: levels.has(input.level) ? input.level : 'info', code: codes.has(input.code) ? input.code : 'console' };
  if (operations.has(input.operation)) event.operation = input.operation;
  if (errorCodes.has(input.errorCode)) event.errorCode = input.errorCode;
  if (names.has(input.name)) event.name = input.name;
  if (typeof input.route === 'string') event.route = diagnosticRoute(input.route);
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method)) event.method = input.method;
  if (Number.isInteger(input.status) && input.status >= 0 && input.status <= 599) event.status = input.status;
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) event.durationMs = Math.min(3_600_000, Math.round(input.durationMs));
  const stack = diagnosticStack(input.stack);
  if (stack) event.stack = stack;
  return event;
}

export function diagnosticBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function boundDiagnosticEvents(events = [], now = Date.now()) {
  const bounded = events.filter(event => Number.isFinite(event?.ts) && event.ts >= now - DIAGNOSTICS_WINDOW_MS && event.ts <= now + 5_000)
    .slice(-DIAGNOSTICS_EVENT_LIMIT);
  let bytes = diagnosticBytes(bounded);
  while (bounded.length && bytes > DIAGNOSTICS_BYTE_LIMIT) {
    bytes -= diagnosticBytes(bounded.shift()) + 1;
  }
  return bounded;
}
