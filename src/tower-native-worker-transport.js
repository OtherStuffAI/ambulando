// Byte transport only. The sync worker retains SSE, cursor and retry ownership.
let port = null;
let nextId = 1;
const pending = new Map();
const readyWaiters = new Set();

function failure(message) { return Object.assign(new Error(message), { code: 'fips_unavailable' }); }
function decode(value) { return Uint8Array.from(atob(value || ''), (c) => c.charCodeAt(0)); }
async function encode(body, signal) {
  if (body == null) return null;
  // Requests use one bounded port message; response bodies remain streaming.
  const limit = 16 * 1024 * 1024;
  const reader = new Response(body).body.getReader();
  const chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw failure('FIPS worker requests are limited to 16 MiB. Reduce the batch or upload through the page.');
      chunks.push(value);
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(value);
}

export function acceptNativeTowerPort(message) {
  if (!['wingman-fips-transport-port', 'wingman-tower-transport-port'].includes(message?.type) || !message.port) return false;
  if (port) {
    for (const request of pending.values()) request.fail(failure('WMapp transport was replaced.'));
    port.close();
  }
  port = message.port;
  port.onmessage = ({ data }) => {
    const request = pending.get(data?.id);
    if (!request) return;
    if (data.type === 'headers') request.headers(data);
    else if (data.type === 'chunk') request.chunk(decode(data.bodyBase64));
    else if (data.type === 'end') request.end();
    else if (data.type === 'error') request.fail(failure('WMapp FIPS request failed. Check pairing and mesh connectivity.'));
  };
  port.start?.();
  for (const ready of readyWaiters) ready();
  readyWaiters.clear();
  return true;
}

async function waitForPort(signal) {
  signal?.throwIfAborted();
  if (port) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      readyWaiters.delete(ready);
      signal?.removeEventListener('abort', abort);
    };
    const ready = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      reject(failure('WMapp native Tower transport is unavailable in this worker.'));
    }, 10000);
    readyWaiters.add(ready);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function nativeWorkerFetch(url, options = {}) {
  await waitForPort(options.signal);
  options.signal?.throwIfAborted();
  const bodyBase64 = await encode(options.body, options.signal);
  options.signal?.throwIfAborted();
  const requestPort = port;
  const id = `fd-${nextId++}`;
  return new Promise((resolve, reject) => {
    let controller;
    let ended = false;
    let receivedHeaders = false;
    let headerTimer;
    const cleanup = () => {
      ended = true;
      clearTimeout(headerTimer);
      pending.delete(id);
      options.signal?.removeEventListener('abort', abort);
    };
    const cancel = () => requestPort.postMessage({ type: 'cancel', id });
    const fail = (error) => {
      if (ended) return;
      cancel();
      cleanup();
      if (receivedHeaders) controller?.error(error);
      else reject(error);
    };
    const abort = () => fail(options.signal.reason || new DOMException('Aborted', 'AbortError'));
    const stream = new ReadableStream({
      start(value) { controller = value; },
      pull() { if (!ended) requestPort.postMessage({ type: 'pull', id }); },
      cancel() { if (!ended) { cancel(); cleanup(); } },
    }, { highWaterMark: 0 });
    pending.set(id, {
      fail,
      headers(data) {
        if (receivedHeaders) return fail(failure('Duplicate native response headers.'));
        try {
          const empty = options.method === 'HEAD' || [204, 205, 304].includes(data.status);
          const response = new Response(empty ? null : stream, { status: data.status, headers: data.headers });
          receivedHeaders = true;
          clearTimeout(headerTimer);
          resolve(response);
          if (empty) { cancel(); cleanup(); }
        } catch { fail(failure('Invalid native response.')); }
      },
      chunk(bytes) {
        if (!receivedHeaders) return fail(failure('Native body arrived before headers.'));
        controller.enqueue(bytes);
      },
      end() {
        if (!receivedHeaders) return fail(failure('Native stream ended before response headers.'));
        cleanup(); controller.close();
      },
    });
    headerTimer = setTimeout(() => fail(failure('WMapp FIPS response timed out.')), 20000);
    options.signal?.addEventListener('abort', abort, { once: true });
    requestPort.postMessage({ type: 'request', id, url: String(url), method: options.method || 'GET', headers: [...new Headers(options.headers)], bodyBase64 });
  });
}
