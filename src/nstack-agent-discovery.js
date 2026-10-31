import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createNip98AuthHeader } from './auth/nostr.js';
import { FLIGHT_DECK_PG_APP_NPUB } from './app-identity.js';
import { nip19 } from 'nostr-tools';

const text = value => String(value ?? '').trim();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function nstackHttpsOrigin(value) {
  let url;
  try { url = new URL(text(value)); } catch { /* validated below */ }
  if (!url || url.protocol !== 'https:' || url.hostname.endsWith('.fips') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('endpoint_invalid', 'Enter a root HTTPS nStack address without credentials or query parameters.');
  }
  return url.origin;
}
export async function nstackJson(url, { fetchImpl = globalThis.fetch, authHeader = createNip98AuthHeader, signed = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (signed) headers.Authorization = await authHeader(url, 'GET', null);
  let response;
  try { response = await fetchImpl(url, { headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { fail('service_offline', 'This service could not be reached. Check its HTTPS address, browser access and service health, then retry.'); }
  if ([401, 403].includes(response.status)) fail('workspace_inaccessible', 'Your signer cannot access this workspace or service. Unlock the intended identity or ask its owner for access.');
  if (!response.ok) fail('service_offline', `The service is unavailable (HTTP ${response.status}). Ask its operator to check the advertised service, then retry.`);
  return response.json();
}
export async function discoverNStackServices(address, options = {}) {
  const origin = nstackHttpsOrigin(address);
  const descriptor = await nstackJson(`${origin}/.well-known/nstack.json`, { ...options, signed: false });
  if (descriptor?.schema !== 'org.wingman.nstack.services' || descriptor.schema_version !== 1 || !Array.isArray(descriptor.services)) fail('descriptor_invalid', 'This address did not return a supported nStack service descriptor.');
  const tower = descriptor.services.filter(service => service.kind === 'tower');
  if (tower.length !== 1 || nstackHttpsOrigin(tower[0].endpoint) !== origin) fail('descriptor_invalid', 'The nStack descriptor must advertise this exact Tower HTTPS origin.');
  const autopilots = descriptor.services.filter(service => service.kind === 'autopilot');
  if (autopilots.length > 1) fail('descriptor_invalid', 'This nStack advertises multiple Autopilot services. Ask its operator to identify the intended service.');
  return { origin, autopilot: autopilots.length ? nstackHttpsOrigin(autopilots[0].endpoint) : null };
}
export async function requireRegisteredAmbulandoApp(origin, ownerNpub, options = {}) {
  const appNpub = options.appNpub || FLIGHT_DECK_PG_APP_NPUB;
  try { if (nip19.decode(appNpub).type !== 'npub') throw new Error(); } catch { fail('ambulando_app_missing', 'The selected workspace has no valid registered app identity. Ask its owner for a valid workspace locator.'); }
  const payload = await nstackJson(`${nstackHttpsOrigin(origin)}/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(options.workspaceId)}/app-registration`, options);
  const descriptor = payload?.registration;
  if (options.towerNpub && payload?.identity?.tower_service_npub !== options.towerNpub) fail('registration_mismatch', 'The registration belongs to a different Tower identity. Refresh the nStack connection before retrying.');
  if (payload?.identity?.workspace_id !== options.workspaceId || payload?.identity?.workspace_owner_npub !== ownerNpub || payload?.identity?.app_npub !== appNpub) fail('registration_mismatch', 'The registered app does not match the selected workspace identity. Refresh workspace discovery and select again.');
  if (!descriptor?.installed || !descriptor.enabled || descriptor.app_npub !== appNpub) {
    fail('ambulando_app_missing', 'Ambulando is not registered and enabled in this workspace. Ask its owner to install or enable Ambulando, then retry.');
  }
  return descriptor;
}
export async function discoverHttpsAutopilot(endpoint, ownerNpub, options = {}) {
  const origin = nstackHttpsOrigin(endpoint);
  try { if (nip19.decode(ownerNpub).type !== 'npub') throw new Error(); } catch { fail('owner_invalid', 'Select a verified workspace owner before discovering agents.'); }
  const base = `/api/owners/${encodeURIComponent(ownerNpub)}/control-plane/v1`;
  const health = await nstackJson(`${origin}${base}/health`, options);
  try { if (nip19.decode(health.installation_npub).type !== 'npub') throw new Error(); } catch { fail('installation_invalid', 'Autopilot did not identify its installation. Ask its operator to update the service.'); }
  if (health.ok !== true || health.api_version !== 1 || !/^autopilot_[a-f0-9]{32}$/.test(health.installation_id)) fail('installation_invalid', 'Autopilot health did not return a supported installation identity.');
  const expectedId = `autopilot_${bytesToHex(sha256(new TextEncoder().encode(nip19.decode(health.installation_npub).data))).slice(0, 32)}`;
  if (health.installation_id !== expectedId) fail('installation_invalid', 'Autopilot installation ID does not match its public identity.');
  return Object.freeze({ installationId: health.installation_id, installationNpub: health.installation_npub,
    transportMode: 'https', httpsEndpoint: origin, fipsEndpoint: null, transportNpub: null,
    apiVersion: 1, version: 0, capabilities: ['health', 'agents.read'], healthPath: `${base}/health`, agentsPath: `${base}/agents` });
}
