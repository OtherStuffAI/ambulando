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
const operations = new Set(['sync', 'startup-sync', 'sse', 'storage', 'workspace-key', 'message-timing', 'worker-failure', 'report-open', 'report-send', 'thread-close', 'navigation', 'thread-rename', 'document-editor', 'task-editor', 'daily-note-editor', 'record-sync', 'record-client', 'channel-create', 'upload']);
const errorCodes = new Set(['pg_read_authority_changed', 'pg_read_authority_resetting', 'worker_unavailable', 'storage_unavailable', 'stale_row_version', 'reset_required', 'history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid', 'checkpoint_conflict', 'checkpoint_regression', 'workspace_membership_required', 'auth_timeout']);
const stages = new Set(['signing', 'request', 'refresh', 'retry', 'import', 'factory', 'opening', 'receiving', 'applying', 'complete', 'recovery', 'prepare', 'transfer', 'upload', 'completion', 'message-create']);
const categories = new Set(['unavailable', 'exception', 'transport', 'http', 'auth', 'cancellation', 'timeout', 'import', 'factory']);
const outcomes = new Set(['attempt', 'succeeded', 'recovered', 'fallback', 'cancelled', 'failed']);
const recoveryReasons = new Set(['reset_required', 'history_pruned', 'client_expired', 'client_not_registered', 'page_token_invalid', 'checkpoint_conflict', 'checkpoint_regression', 'unsupported', 'upgrade', 'protocol-change']);
const assetPattern = '(?:index|diagnostics-worker|sync-worker|tower-pg-materialization-worker|tiptap-editor-adapter|task-description-editor|pg-record-delta|pg-device-checkpoints)-[A-Za-z0-9_-]{8,16}\\.js';
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'AbortError', 'NetworkError', 'TransactionInactiveError', 'SecurityError']);

// Match positions in approved endpoint templates, never classify an identifier
// by its spelling. An ID named "ack" or "docs" is still an ID.
const pgRoot = '/api/v4/flightdeck-pg/workspaces/:id';
const routes = [
  '/health', '/version.json', '/index.html', '/assets/:id',
  '/api/v4/flightdeck-pg/service', '/api/v4/flightdeck-pg/workspaces',
  '/api/v4/workspaces/:id/docs/:id', '/api/v4/workspaces/:id/docs',
  '/api/v4/storage/:id/complete', '/api/v4/storage/:id/content', '/api/v4/storage/:id/download-url', '/api/v4/storage/:id', '/api/v4/storage/prepare',
  pgRoot, ...['record-sync', 'sync', 'events', 'members', 'groups', 'scopes', 'channels', 'tasks', 'docs', 'files', 'threads', 'messages', 'message-activity', 'resource-view-states', 'me', 'descriptor', 'storage-usage'].map(part => `${pgRoot}/${part}`),
  `${pgRoot}/storage/prepare`,
  `${pgRoot}/record-sync/clients/:id/ack`, `${pgRoot}/record-sync/clients/:id`,
  ...['threads', 'messages', 'tasks', 'docs', 'channels', 'scopes', 'files', 'groups'].flatMap(part => [
    `${pgRoot}/${part}/:id`, ...['body', 'comments', 'versions', 'recoveries', 'state', 'events', 'stream', 'members', 'grants'].map(end => `${pgRoot}/${part}/:id/${end}`),
  ]),
  ...['threads', 'messages', 'tasks', 'docs', 'files', 'audio-notes', 'file-folders', 'response-activities', 'workrooms'].map(part => `${pgRoot}/channels/:id/${part}`),
];

export function diagnosticRoute(value) {
  try {
    const path = new URL(String(value), 'https://diagnostics.invalid').pathname;
    const parts = path.split('/').filter(Boolean);
    const template = routes.find(route => {
      const expected = route.split('/').filter(Boolean);
      return expected.length === parts.length && expected.every((part, i) => part === ':id' || part === parts[i]);
    });
    return template || '/:unknown';
  } catch { return '/:unknown'; }
}

export function diagnosticAsset(value) {
  try {
    const path = new URL(String(value), 'https://diagnostics.invalid').pathname;
    return path.match(new RegExp(`^/assets/(${assetPattern})$`))?.[1] || null;
  } catch { return null; }
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
  if (typeof input.asset === 'string' && new RegExp(`^${assetPattern}$`).test(input.asset)) event.asset = input.asset;
  for (const field of ['line', 'column']) if (Number.isSafeInteger(input[field]) && input[field] >= 0 && input[field] <= 9_999_999) event[field] = input[field];
  if (stages.has(input.stage)) event.stage = input.stage;
  if (categories.has(input.category)) event.category = input.category;
  if (outcomes.has(input.outcome)) event.outcome = input.outcome;
  if (recoveryReasons.has(input.recoveryReason)) event.recoveryReason = input.recoveryReason;
  if (['snapshot', 'delta', 'unavailable'].includes(input.mode)) event.mode = input.mode;
  // Correlations must be minted by diagnostics-events, never copied from IDs.
  if (typeof input.correlation === 'string' && /^d-[a-f0-9]{32}$/.test(input.correlation)) event.correlation = input.correlation;
  for (const field of ['page', 'applied', 'protocolVersion']) {
    if (Number.isSafeInteger(input[field]) && input[field] >= 0) event[field] = Math.min(input[field], 1_000_000_000);
  }
  for (const field of ['cursorPresent', 'hasMore', 'fullSnapshot']) if (typeof input[field] === 'boolean') event[field] = input[field];
  if (typeof input.route === 'string') event.route = diagnosticRoute(input.route);
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method)) event.method = input.method;
  if (Number.isInteger(input.status) && input.status >= 0 && input.status <= 599) event.status = input.status;
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) event.durationMs = Math.min(3_600_000, Math.round(input.durationMs));
  const stack = diagnosticStack(input.stack);
  if (stack) event.stack = stack;
  return event;
}

export function diagnosticBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function boundDiagnosticEvents(events = [], now = Date.now(), end = now + 5_000) {
  const valid = events.filter(event => Number.isFinite(event?.ts) && event.ts >= now - DIAGNOSTICS_WINDOW_MS && event.ts <= end);
  const priority = event => event.level === 'error' ? 2 : event.level === 'warn' || event.code === 'recovery' ? 1 : 0;
  const selected = valid.map((event, index) => ({ event, index })).sort((a, b) => priority(b.event) - priority(a.event) || b.index - a.index).slice(0, DIAGNOSTICS_EVENT_LIMIT);
  const bounded = selected.sort((a, b) => a.index - b.index).map(item => item.event);
  let bytes = diagnosticBytes(bounded);
  while (bounded.length && bytes > DIAGNOSTICS_BYTE_LIMIT) {
    const lowest = Math.min(...bounded.map(priority));
    const index = bounded.findIndex(event => priority(event) === lowest);
    bytes -= diagnosticBytes(bounded.splice(index, 1)[0]) + 1;
  }
  return bounded;
}
