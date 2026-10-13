import { nativeWorkerFetch } from './tower-native-worker-transport.js';
import { nip19 } from 'nostr-tools';

// A connection preference never becomes a workspace identity. Native
// route capabilities are ephemeral and must never be persisted or logged.
const STORAGE_KEY = 'flightdeck:tower-transports:v1';
let connections = new Map();
let savedPreferences = new Map();
let transportGeneration = 0;

function transportError(message) {
  return Object.assign(new Error(message), { code: 'fips_unavailable' });
}

export function normalizeFipsEndpoint(value) {
  const endpoint = new URL(String(value || '').trim());
  const node = endpoint.hostname.replace(/\.fips$/, '');
  let validNode = false;
  try { validNode = nip19.decode(node).type === 'npub'; } catch { /* invalid pairing */ }
  if (endpoint.protocol !== 'http:' || !endpoint.hostname.endsWith('.fips') || !validNode
    || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') {
    throw transportError('Use one exact http://<node-npub>.fips:<port>/ Tower endpoint.');
  }
  return endpoint.origin;
}

function logicalOrigin(value) {
  const url = new URL(String(value || '').trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Tower must be an HTTP(S) origin.');
  return url.origin;
}

function readLegacyPreferences(storage = globalThis.localStorage) {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Tower transport preferences.');
  return parsed;
}

function persistentPreference(preference) {
  if (!['https', 'fips'].includes(preference?.mode)) throw new Error('Invalid Tower transport mode.');
  const result = { mode: preference.mode };
  if (preference.mode === 'fips' || preference.endpoint || preference.serviceNpub) {
    try {
      if (nip19.decode(preference.serviceNpub).type !== 'npub') throw new Error();
    } catch { throw new Error('Verified Tower identity is required.'); }
    result.endpoint = normalizeFipsEndpoint(preference.endpoint);
    result.serviceNpub = preference.serviceNpub;
  }
  return result;
}

async function preferenceDb() {
  // Persistence is only used by page boot/settings, never request routing.
  return (await import('./db.js')).getSharedDb();
}

async function migratePreferences(db, storage) {
  const legacy = readLegacyPreferences(storage);
  const entries = Object.entries(legacy);
  if (!entries.length) return;
  await db.transaction('rw', db.tower_transport_preferences, async () => {
    for (const [tower, preference] of entries) {
      const logicalTower = logicalOrigin(tower);
      // A committed choice always wins over a stale legacy copy, including HTTPS.
      if (!await db.tower_transport_preferences.get(logicalTower)) {
        await db.tower_transport_preferences.add({ logicalTower, ...persistentPreference(preference) });
      }
    }
  });
  // A failed write leaves the legacy source intact. Failed cleanup is harmless:
  // migration is idempotent and cannot overwrite the committed database choice.
  try { (storage ?? globalThis.localStorage)?.removeItem(STORAGE_KEY); } catch { /* retry next boot */ }
}

export function getTowerTransportPreference(logicalTower) {
  try { return { ...(savedPreferences.get(logicalOrigin(logicalTower)) || { mode: 'https' }) }; }
  catch { return { mode: 'https' }; }
}

export function getTowerTransport(logicalTower) {
  if (!logicalTower) return { mode: 'https' };
  try { return connections.get(new URL(logicalTower).origin) || { mode: 'https' }; }
  catch { return { mode: 'https' }; }
}

export function exportTowerTransports() {
  return [...connections.entries()].map(([logicalTower, { handle: _handle, ...connection }]) => ({ logicalTower, ...connection }));
}

export function importTowerTransports(snapshot = []) {
  transportGeneration++;
  connections = new Map(snapshot.map(({ logicalTower, ...connection }) => [logicalTower, connection]));
}

export function suspendTowerTransports() {
  transportGeneration++;
  for (const [tower, connection] of connections) {
    if (connection.mode !== 'fips') continue;
    connections.set(tower, { mode: 'fips', endpoint: connection.endpoint,
      serviceNpub: connection.serviceNpub, error: 'FIPS document capability was revoked.' });
    void Promise.resolve().then(() => connection.handle?.disconnect?.()).catch(() => {});
  }
}

export async function connectTowerBridge(logicalTower, endpoint, expectedServiceNpub, {
  transport = globalThis.window?.fipsTransport,
} = {}) {
  logicalTower = logicalOrigin(logicalTower);
  endpoint = normalizeFipsEndpoint(endpoint);
  if (!transport || transport.version < 2 || transport.available === false || typeof transport.connect !== 'function') {
    throw transportError('FIPS requires WMapp with scoped transport handles. Public HTTPS remains available in Connection settings.');
  }
  if (!expectedServiceNpub) throw transportError('The selected workspace has no verified Tower service identity.');
  const peerNpub = new URL(endpoint).hostname.slice(0, -'.fips'.length);
  let handle;
  try {
    handle = await transport.connect({ endpoint, peerNpub, purpose: 'tower' });
    if (handle?.version !== 2 || handle.endpoint !== endpoint || handle.peerNpub !== peerNpub
      || handle.purpose !== 'tower' || typeof handle.fetch !== 'function' || typeof handle.disconnect !== 'function') {
      throw transportError('WMapp returned an incompatible Tower transport handle.');
    }
    const response = await handle.fetch(`${endpoint}/health`, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw transportError(`FIPS Tower health failed (${response.status}).`);
    const health = await response.json();
    if (health.service_npub !== expectedServiceNpub) {
      throw transportError('The paired endpoint does not identify the configured Tower.');
    }
  } catch (error) {
    await handle?.disconnect?.();
    throw error;
  }
  return { mode: 'fips', endpoint, transport: 'native', serviceNpub: expectedServiceNpub, handle };
}

export async function initializeTowerTransports(options = {}) {
  const generation = ++transportGeneration;
  const db = await preferenceDb();
  await migratePreferences(db, options.storage);
  const rows = await db.tower_transport_preferences.toArray();
  if (generation !== transportGeneration) return;
  const preferences = Object.fromEntries(rows.map(({ logicalTower, ...preference }) => [logicalTower, preference]));
  savedPreferences = new Map(Object.entries(preferences));
  const windowObject = globalThis.window;
  if (!Object.hasOwn(options, 'transport') && Object.values(preferences).some((p) => p.mode === 'fips')
    && !windowObject?.fipsTransport && windowObject?.addEventListener) {
    // WMapp injects at onPageFinished, after module boot has begun.
    await new Promise((resolve) => {
      const ready = () => {
        clearTimeout(timer);
        windowObject.removeEventListener('wingman-fips-transport-ready', ready);
        resolve();
      };
      const timer = setTimeout(ready, 5000);
      windowObject.addEventListener('wingman-fips-transport-ready', ready, { once: true });
    });
  }
  if (generation !== transportGeneration) return;
  connections = new Map();
  await Promise.all(Object.entries(preferences).map(async ([logicalTower, preference]) => {
    if (preference.mode !== 'fips') return;
    // Register the unavailable state before awaiting native pairing. No request
    // may silently use HTTPS while a saved FIPS preference reconnects.
    connections.set(logicalTower, { mode: 'fips', endpoint: preference.endpoint, serviceNpub: preference.serviceNpub, error: 'FIPS bridge is connecting.' });
    try {
      const connection = await connectTowerBridge(logicalTower, preference.endpoint, preference.serviceNpub, options);
      if (generation !== transportGeneration) {
        await connection.handle.disconnect();
        return;
      }
      connections.set(logicalTower, connection);
    } catch (error) {
      if (generation !== transportGeneration) return;
      connections.set(logicalTower, { mode: 'fips', endpoint: preference.endpoint, serviceNpub: preference.serviceNpub, error: `FIPS unavailable: ${error.message}` });
    }
  }));
}

// Save only after pairing and identity validation. Activation occurs on reload,
// so in-flight acknowledgements are never reinterpreted under another route.
export async function saveTowerTransportPreference(logicalTower, preference) {
  const origin = logicalOrigin(logicalTower);
  const db = await preferenceDb();
  let saved;
  await db.transaction('rw', db.tower_transport_preferences, async () => {
    const previous = await db.tower_transport_preferences.get(origin);
    saved = persistentPreference(preference.mode === 'https'
      ? { ...previous, mode: 'https' } : preference);
    await db.tower_transport_preferences.put({ logicalTower: origin, ...saved });
  });
  savedPreferences.set(origin, saved);
}

function resolveRequest(value) {
  const input = new URL(String(value));
  for (const [logicalTower, connection] of connections) {
    if (connection.mode !== 'fips') continue;
    if (input.origin !== logicalTower && input.origin !== connection.endpoint) continue;
    const path = `${input.pathname}${input.search}`;
    if (connection.error || connection.transport !== 'native') throw transportError(connection.error || 'FIPS bridge is unavailable.');
    if (input.username || input.password || input.hash) throw transportError('Invalid Tower request URL.');
    return { signingUrl: `${connection.endpoint}${path}`, networkUrl: `${connection.endpoint}${path}`, fips: true };
  }
  // An unmapped mesh URL must never fall through to browser HTTP or another node.
  if (input.hostname.endsWith('.fips')) throw transportError('This FIPS endpoint has not been paired with Tower.');
  return { signingUrl: String(value), networkUrl: String(value), fips: false };
}

export function resolveTowerSigningUrl(value) { return resolveRequest(value).signingUrl; }

export async function towerFetch(value, options) {
  const request = resolveRequest(value);
  try {
    if (!request.fips) return await (options === undefined ? globalThis.fetch(request.networkUrl) : globalThis.fetch(request.networkUrl, options));
    return await nativeTowerFetch(request.networkUrl, options);
  } catch (error) {
    if (options?.signal?.aborted) throw options.signal.reason;
    if (!request.fips || ['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
    // Do not include the native capability URL or signed SSE token in errors.
    throw transportError(`FIPS request failed: ${error.name || 'network error'}. Check WMapp pairing or select Public HTTPS.`);
  }
}

export async function nativeTowerFetch(endpointUrl, options = {}) {
  const transport = globalThis.window?.fipsTransport;
  if (globalThis.window && (!transport || transport.version < 2 || transport.available === false)) {
    throw transportError('WMapp native Tower transport is unavailable.');
  }
  const connection = [...connections.values()].find((candidate) => candidate.mode === 'fips'
    && new URL(endpointUrl).origin === candidate.endpoint);
  const fetchNative = connection?.handle?.fetch
    ? connection.handle.fetch.bind(connection.handle)
    : nativeWorkerFetch;
  return fetchNative(endpointUrl, { ...options, credentials: 'omit', redirect: 'error' });
}

export function usesNativeTowerTransport(value) { return resolveRequest(value).fips; }

export function resolveTowerLogicalUrl(value) {
  let input;
  try { input = new URL(value); } catch { return value; }
  for (const [logicalTower, connection] of connections) {
    if (connection.mode === 'fips' && input.origin === connection.endpoint) {
      return `${logicalTower}${input.pathname === '/' && !input.search ? '' : input.pathname}${input.search}${input.hash}`;
    }
  }
  return value;
}

// Locators describe authority identity, not the route used to retrieve them.
// Normalize only contract-owned locator fields, never user metadata/content.
export function normalizeTowerConnectionResponse(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const locator = (value) => value && typeof value === 'object' && value.tower_base_url
    ? { ...value, tower_base_url: resolveTowerLogicalUrl(value.tower_base_url) } : value;
  const result = locator(payload);
  return {
    ...result,
    ...(result.descriptor ? { descriptor: locator(result.descriptor) } : {}),
    ...(Array.isArray(result.workspaces) ? { workspaces: result.workspaces.map(locator) } : {}),
    ...(result.service?.base_url ? { service: { ...result.service, base_url: resolveTowerLogicalUrl(result.service.base_url) } } : {}),
  };
}
