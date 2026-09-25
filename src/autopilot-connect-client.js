import { nip19, verifyEvent } from 'nostr-tools';
import { createNip98AuthHeader } from './auth/nostr.js';

export const AUTOPILOT_CONNECT_KIND = 'wingman_autopilot_connect';
export const AUTOPILOT_CONNECT_VERSION = 1;
export const AUTOPILOT_CONNECT_TRANSPORT_VERSION = 2;
export const AUTOPILOT_CONNECT_SIGNATURE_KIND = 27236;
export const AUTOPILOT_CONNECT_MAX_AGE_SECONDS = 300;

const SECRET_KEY_PATTERN = /(^|_)(nsec|secret|private_key|bearer|token|bunker_uri|nwc|wallet_connect)(_|$)/i;
const SECRET_VALUE_PATTERN = /^(nsec1|nostr\+walletconnect:|nostrconnect:|bunker:|bearer\s+)/i;
const CREDENTIAL_QUERY_PATTERN = /(^|_)(nsec|secret|private|key|bearer|token|auth|credential|password|bunker)(_|$)/i;

export class AutopilotConnectError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AutopilotConnectError';
    this.code = code;
    if (options.status != null) this.status = options.status;
    if (options.correlationId) this.correlationId = options.correlationId;
  }
}

function fail(code, message, options) {
  throw new AutopilotConnectError(code, message, options);
}

function text(value) {
  return String(value ?? '').trim();
}

function correlationId() {
  return globalThis.crypto?.randomUUID?.() || `connect-${Date.now().toString(36)}`;
}

function diagnose(stage, id, fields = {}) {
  console.info('[agent-connect]', JSON.stringify({ component: 'flightdeck_agent_connect', stage, correlationId: id, ...fields }));
}

function nativePublicError(error) {
  const message = text(error?.message);
  const match = /^([a-z][a-z0-9_]{2,48}): ([^\r\n]{1,280})$/.exec(message);
  return match ? { code: match[1], message: match[2] } : null;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  fail('package_invalid', 'Autopilot Connect Package contains a value that cannot be signed safely.');
}

function decodeNpub(value, label) {
  try {
    const decoded = nip19.decode(text(value));
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') throw new Error();
    return decoded.data;
  } catch {
    fail('package_invalid', `${label} must be a valid npub.`);
  }
}

function assertNoSecrets(value, path = 'package') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!plainObject(value)) {
    if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value.trim())) {
      fail('package_secret', `Autopilot Connect Package contains forbidden secret material at ${path}.`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      fail('package_secret', `Autopilot Connect Package contains forbidden credential field ${path}.${key}.`);
    }
    assertNoSecrets(entry, `${path}.${key}`);
  }
}

function exactFipsOrigin(value) {
  let endpoint;
  try { endpoint = new URL(text(value)); } catch { fail('endpoint_invalid', 'The package FIPS endpoint is not a valid URL.'); }
  if (endpoint.protocol !== 'http:' || !endpoint.hostname.endsWith('.fips') || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    fail('endpoint_invalid', 'The package must advertise one exact http://<transport-npub>.fips:<port> endpoint.');
  }
  const endpointNpub = endpoint.hostname.slice(0, -'.fips'.length);
  decodeNpub(endpointNpub, 'FIPS endpoint identity');
  return { endpoint: endpoint.origin, endpointNpub };
}

function exactPath(value, label) {
  const path = text(value);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.includes('\\')
    || [...path].some((character) => character.codePointAt(0) < 32)) {
    fail('package_invalid', `${label} must be an absolute path on the advertised FIPS endpoint.`);
  }
  let parsed;
  try { parsed = new URL(path, 'http://signed-path.invalid'); } catch { fail('package_invalid', `${label} is invalid.`); }
  if (parsed.origin !== 'http://signed-path.invalid'
    || [...parsed.searchParams.keys()].some((key) => CREDENTIAL_QUERY_PATTERN.test(key))) {
    fail('package_secret', `${label} contains an unsafe or credential-like query.`);
  }
  return path;
}

function optionalHttpsOrigin(value) {
  if (value == null || text(value) === '') return null;
  let endpoint;
  try { endpoint = new URL(text(value)); } catch { fail('endpoint_invalid', 'The package HTTPS endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash
    || [...endpoint.searchParams.keys()].some((key) => CREDENTIAL_QUERY_PATTERN.test(key))) {
    fail('endpoint_invalid', 'The package HTTPS endpoint must be public and credential-free.');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function parseInput(input) {
  if (plainObject(input)) return input;
  try {
    const parsed = JSON.parse(text(input));
    if (!plainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    fail('package_invalid', 'Autopilot Connect Package must be a JSON object.');
  }
}

export function createAutopilotConnectPackageEnvelope(manifest, signedEvent) {
  return { manifest, signature: signedEvent };
}

export function autopilotConnectManifestContent(manifest) {
  return canonicalJson(manifest);
}

export function verifyAutopilotConnectPackage(input, { now = new Date(), maxAgeSeconds = AUTOPILOT_CONNECT_MAX_AGE_SECONDS } = {}) {
  const requestId = correlationId();
  diagnose('package_validation_started', requestId);
  const envelope = parseInput(input);
  assertNoSecrets(envelope);
  const manifest = envelope.manifest;
  const signature = envelope.signature;
  if (!plainObject(manifest) || !plainObject(signature)) {
    fail('package_invalid', 'Autopilot Connect Package requires manifest and signature objects.');
  }
  if (manifest.kind !== AUTOPILOT_CONNECT_KIND) {
    fail('package_invalid', 'This is not an Autopilot Connect Package.');
  }
  if (![AUTOPILOT_CONNECT_VERSION, AUTOPILOT_CONNECT_TRANSPORT_VERSION].includes(manifest.version)) {
    fail('package_version_unsupported', `Autopilot Connect Package version ${String(manifest.version)} is not supported.`);
  }
  if (signature.kind !== AUTOPILOT_CONNECT_SIGNATURE_KIND || !verifyEvent(signature)) {
    fail('package_signature_invalid', 'Autopilot Connect Package signature is invalid or the package was tampered with.');
  }
  if (signature.content !== canonicalJson(manifest)) {
    fail('package_tampered', 'Autopilot Connect Package content does not match its signed manifest.');
  }

  const installationId = text(manifest.installation?.id);
  const installationNpub = text(manifest.installation?.npub);
  if (!installationId) fail('package_invalid', 'Autopilot installation id is required.');
  const installationPubkey = decodeNpub(installationNpub, 'Autopilot installation identity');
  if (signature.pubkey !== installationPubkey) {
    fail('installation_mismatch', 'Package signer does not match the advertised Autopilot installation identity.');
  }
  const generatedAtMs = Date.parse(manifest.generated_at);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(nowMs)
    || generatedAtMs > nowMs + 15_000 || nowMs - generatedAtMs > Number(maxAgeSeconds) * 1000) {
    fail('package_expired', 'Autopilot Connect Package generation time is invalid or expired.');
  }
  if (Math.abs(Number(signature.created_at) * 1000 - generatedAtMs) >= 1000) {
    fail('package_tampered', 'Autopilot Connect Package generation time is not bound to its signature.');
  }
  if (signature.tags?.find((tag) => tag?.[0] === 'd')?.[1] !== installationId) {
    fail('package_tampered', 'Autopilot Connect Package installation id is not signed correctly.');
  }
  const transportNpub = manifest.version === AUTOPILOT_CONNECT_TRANSPORT_VERSION
    ? text(manifest.transport?.fips?.npub)
    : installationNpub;
  decodeNpub(transportNpub, 'FIPS transport identity');
  const fips = exactFipsOrigin(manifest.endpoints?.fips);
  if (fips.endpointNpub !== transportNpub) {
    fail('endpoint_mismatch', 'FIPS endpoint identity does not match the signed transport identity.');
  }
  if (manifest.api?.version !== 1) {
    fail('api_version_unsupported', `Autopilot discovery API version ${String(manifest.api?.version)} is not supported; expected version 1.`);
  }

  const verified = Object.freeze({
    correlationId: requestId,
    kind: manifest.kind,
    version: manifest.version,
    generatedAt: text(manifest.generated_at) || null,
    installationId,
    installationNpub,
    transportNpub,
    fipsEndpoint: fips.endpoint,
    httpsEndpoint: optionalHttpsOrigin(manifest.endpoints?.https),
    apiVersion: manifest.api.version,
    capabilities: Object.freeze([...new Set((manifest.api.capabilities || []).map(text).filter(Boolean))]),
    healthPath: exactPath(manifest.api.health_path, 'Health route'),
    agentsPath: exactPath(manifest.api.agents_path, 'Agent discovery route'),
    controlledRestartPath: manifest.api.capabilities?.includes('system.controlled-restart.v1')
      ? exactPath(manifest.api.controlled_restart_path, 'Controlled restart route') : null,
    controlledRestartStatusPath: manifest.api.capabilities?.includes('system.controlled-restart.v1')
      ? exactPath(manifest.api.controlled_restart_status_path, 'Controlled restart status route') : null,
  });
  diagnose('package_validation_succeeded', requestId, {
    version: verified.version,
    endpointHost: new URL(verified.fipsEndpoint).hostname,
    endpointPort: new URL(verified.fipsEndpoint).port,
  });
  return verified;
}

function mapResponseFailure(response, operation) {
  if (response.status === 401 || response.status === 403) {
    return new AutopilotConnectError('auth_failed', `Autopilot rejected NIP-98 authorization for ${operation}.`, { status: response.status });
  }
  if (response.status === 404 || response.status === 405) {
    return new AutopilotConnectError('route_unavailable', `Autopilot does not expose the advertised ${operation} route.`, { status: response.status });
  }
  return new AutopilotConnectError('connection_failed', `Autopilot ${operation} failed with HTTP ${response.status}.`, { status: response.status });
}

function normalizeAgent(row) {
  if (!plainObject(row)) return null;
  const agentId = text(row.agent_id);
  const botNpub = text(row.bot_npub);
  if (!agentId || !botNpub) return null;
  try { decodeNpub(botNpub, 'Agent identity'); } catch { return null; }
  let paths;
  try {
    paths = Object.freeze(Object.fromEntries(['overview', 'pipelines', 'schedules', 'triggers']
      .map((key) => [key, exactPath(row.paths?.[key], `Agent ${key} route`)])));
  } catch { return null; }
  return Object.freeze({
    agentId,
    botNpub,
    name: text(row.name) || 'Agent',
    description: text(row.description),
    canInstruct: row.can_instruct === true,
    paths,
  });
}

export function createAutopilotDiscoveryClient(verifiedPackage, {
  transport = globalThis.window?.fipsTransport,
  authHeader = createNip98AuthHeader,
  timeoutMs = 20_000,
} = {}) {
  if (!verifiedPackage?.fipsEndpoint || !verifiedPackage?.installationNpub || !verifiedPackage?.transportNpub) {
    fail('package_unverified', 'Verify the Autopilot Connect Package before connecting.');
  }
  if (!transport || transport.version < 2 || transport.available === false
    || typeof transport.connect !== 'function') {
    fail('fips_unavailable', 'Native FIPS transport is unavailable. Open Flight Deck in a supported, unlocked Wingman app.');
  }
  let connected = false;
  let handle = null;
  const requestId = verifiedPackage.correlationId || correlationId();
  const advertisedPaths = new Set([verifiedPackage.healthPath, verifiedPackage.agentsPath]);
  if (verifiedPackage.controlledRestartPath) advertisedPaths.add(verifiedPackage.controlledRestartPath);
  if (verifiedPackage.controlledRestartStatusPath) advertisedPaths.add(verifiedPackage.controlledRestartStatusPath);

  function liveThreadPath(context, kind, after = '') {
    const query = new URLSearchParams({
      workspace_id: text(context?.workspaceId),
      tower_service_npub: text(context?.towerServiceNpub),
      app_npub: text(context?.appNpub),
      channel_id: text(context?.channelId),
      agent_npub: text(context?.agentNpub),
    });
    if (kind === 'events') query.set('after', text(after || '0'));
    return `/api/owners/${encodeURIComponent(text(context?.ownerNpub))}/control-plane/v1/live-threads/${encodeURIComponent(text(context?.threadId))}/${kind}?${query}`;
  }

  async function connect() {
    let descriptor;
    diagnose('native_connect_invoked', requestId);
    try {
      descriptor = await transport.connect({
        endpoint: verifiedPackage.fipsEndpoint,
        peerNpub: verifiedPackage.transportNpub,
        purpose: 'autopilot',
      });
    }
    catch (error) {
      const nativeError = nativePublicError(error);
      diagnose('native_connect_failed', requestId, {
        publicCode: nativeError?.code || 'fips_connection_failed',
      });
      if (nativeError) {
        fail(nativeError.code, nativeError.message, { cause: error, correlationId: requestId });
      }
      fail('fips_connection_failed', 'Could not connect to the signed Autopilot FIPS endpoint. Open WMapp Setup and check FIPS diagnostics.', { cause: error, correlationId: requestId });
    }
    if (descriptor?.version !== 2 || descriptor.endpoint !== verifiedPackage.fipsEndpoint
      || descriptor.peerNpub !== verifiedPackage.transportNpub || descriptor.purpose !== 'autopilot'
      || typeof descriptor.fetch !== 'function' || typeof descriptor.disconnect !== 'function') {
      await descriptor?.disconnect?.();
      fail('endpoint_mismatch', 'Native FIPS bridge connected to a different endpoint than the signed package.');
    }
    handle = descriptor;
    diagnose('native_connect_succeeded', requestId);
    connected = true;
  }

  async function requestResponse(path, operation, { method = 'GET', body, accept = 'application/json', signal } = {}) {
    if (!connected) await connect();
    const requestUrl = `${verifiedPackage.fipsEndpoint}${path}`;
    const normalizedMethod = text(method).toUpperCase();
    const serializedBody = body === undefined
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body));
    let authorization;
    try { authorization = await authHeader(requestUrl, normalizedMethod, serializedBody ?? null); }
    catch (error) {
      const nativeError = nativePublicError(error);
      diagnose('auth_signing_failed', requestId, {
        publicCode: nativeError?.code || 'auth_signing_failed',
        operation,
      });
      fail(
        nativeError?.code || 'auth_signing_failed',
        nativeError?.message || `Could not sign the exact Autopilot ${operation} request.`,
        { cause: error, correlationId: requestId },
      );
    }
    let response;
    try {
      response = await handle.fetch(requestUrl, {
        method: normalizedMethod,
        headers: {
          Accept: accept,
          Authorization: authorization,
          ...(serializedBody === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: serializedBody,
        credentials: 'omit',
        redirect: 'error',
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('connection_failed', `Could not reach Autopilot ${operation} through FIPS.`, { cause: error });
    }
    if (!response.ok) throw mapResponseFailure(response, operation);
    return response;
  }

  async function request(path, operation, options = {}) {
    const response = await requestResponse(path, operation, options);
    try { return await response.json(); }
    catch (error) { fail('response_invalid', `Autopilot returned invalid JSON for ${operation}.`, { cause: error }); }
  }

  return Object.freeze({
    async refreshConnectPackage() {
      const ownerMatch = verifiedPackage.healthPath.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/health$/);
      if (!ownerMatch) fail('route_unavailable', 'The stored Autopilot connection does not contain a verified owner health route.');
      const ownerNpub = decodeURIComponent(ownerMatch[1]);
      const path = `/api/control-plane/v2/connect-package?owner_npub=${encodeURIComponent(ownerNpub)}`;
      const envelope = await request(path, 'Connect capability refresh');
      const refreshed = verifyAutopilotConnectPackage(envelope);
      if (refreshed.installationId !== verifiedPackage.installationId
        || refreshed.installationNpub !== verifiedPackage.installationNpub
        || refreshed.transportNpub !== verifiedPackage.transportNpub
        || refreshed.fipsEndpoint !== verifiedPackage.fipsEndpoint) {
        fail('installation_mismatch', 'Refreshed Autopilot Connect Package does not match the installed connection.');
      }
      return refreshed;
    },
    requestJson(path, options = {}) {
      if (!advertisedPaths.has(path)) {
        fail('route_unavailable', 'Request path was not signed into this Autopilot Connect Package.');
      }
      return request(path, 'control API', options);
    },
    async health() {
      const payload = await request(verifiedPackage.healthPath, 'health');
      if (payload?.installation_id !== verifiedPackage.installationId
        || payload?.installation_npub !== verifiedPackage.installationNpub
        || payload?.api_version !== verifiedPackage.apiVersion) {
        fail('installation_mismatch', 'Autopilot health identity or API version does not match the signed package.');
      }
      return Object.freeze({
        ok: payload.ok === true,
        installationId: payload.installation_id,
        installationNpub: payload.installation_npub,
        apiVersion: payload.api_version,
      });
    },
    async discoverAgents() {
      diagnose('agent_discovery_started', requestId);
      const payload = await request(verifiedPackage.agentsPath, 'agent discovery');
      if (payload?.installation_id !== verifiedPackage.installationId || !Array.isArray(payload?.agents)) {
        fail('response_invalid', 'Autopilot agent discovery response does not match the signed installation.');
      }
      const agents = payload.agents.map(normalizeAgent).filter(Boolean);
      agents.flatMap((agent) => Object.values(agent.paths)).forEach((path) => advertisedPaths.add(path));
      diagnose('agent_discovery_succeeded', requestId, { agentCount: agents.length });
      return Object.freeze(agents);
    },
    controlledRestart() {
      if (!verifiedPackage.capabilities?.includes('system.controlled-restart.v1') || !verifiedPackage.controlledRestartPath) {
        fail('route_unavailable', 'Autopilot does not advertise controlled restart. Reconnect it with a current package.');
      }
      return request(verifiedPackage.controlledRestartPath, 'controlled restart', {
        method: 'POST', body: { confirm: 'controlled-restart' },
      });
    },
    controlledRestartStatus() {
      if (!verifiedPackage.capabilities?.includes('system.controlled-restart.v1') || !verifiedPackage.controlledRestartStatusPath) {
        fail('route_unavailable', 'Autopilot does not advertise controlled restart status. Reconnect it with a current package.');
      }
      return request(verifiedPackage.controlledRestartStatusPath, 'controlled restart status');
    },
    async readAgent(agent, view) {
      const normalizedView = text(view);
      if (!['overview', 'pipelines', 'schedules', 'triggers'].includes(normalizedView)) {
        fail('route_unavailable', 'Unknown Agent Space view.');
      }
      const path = agent?.paths?.[normalizedView];
      if (!path) fail('route_unavailable', `Agent does not advertise a ${normalizedView} route.`);
      advertisedPaths.add(path);
      const payload = await request(path, `agent ${normalizedView}`);
      if (payload?.installation_id !== verifiedPackage.installationId) {
        fail('installation_mismatch', `Autopilot ${normalizedView} response does not match the signed installation.`);
      }
      const responseAgentId = text(payload.agent_id || payload.agent?.agent_id);
      const responseBotNpub = text(payload.bot_npub || payload.agent?.bot_npub);
      if (responseAgentId !== agent.agentId || (responseBotNpub && responseBotNpub !== agent.botNpub)) {
        fail('response_invalid', `Autopilot ${normalizedView} response does not match the selected agent.`);
      }
      return payload;
    },
    async liveThreadSnapshot(context) {
      if (!verifiedPackage.capabilities?.includes('flightdeck.live-thread-activity.v1')) {
        fail('route_unavailable', 'Autopilot does not advertise live thread activity.');
      }
      return request(liveThreadPath(context, 'snapshot'), 'live thread activity snapshot');
    },
    async liveThreadEvents(context, after = '0', signal) {
      if (!verifiedPackage.capabilities?.includes('flightdeck.live-thread-activity.v1')) {
        fail('route_unavailable', 'Autopilot does not advertise live thread activity.');
      }
      return requestResponse(liveThreadPath(context, 'events', after), 'live thread activity stream', {
        accept: 'text/event-stream', signal,
      });
    },
    async disconnect() {
      connected = false;
      const selectedHandle = handle;
      handle = null;
      await selectedHandle?.disconnect?.();
    },
  });
}
