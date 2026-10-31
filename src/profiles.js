import { canonicalProfileNpub, profileHex } from './profile-identity.js';
import { getCachedProfile } from './db.js';

export const npubToHex = profileHex;
let worker;
let nextId = 0;
const requests = new Map();
const inFlight = new Map();
const queued = [];
let active = 0;

async function inRelayLane(operation) {
  if (active >= 4) await new Promise(resolve => queued.push(resolve));
  active++;
  try { return await operation(); }
  finally { active--; queued.shift()?.(); }
}

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(new URL('./worker/profile-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const request = requests.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    requests.delete(data.id);
    request.resolve(data.profile);
  };
  worker.onerror = () => {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.resolve(null);
    }
    requests.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

// Rendering can enqueue this method, but only the worker opens relay sockets.
// Callers hydrate cached data separately, then apply this background result.
export function fetchProfileByNpub(identity, options = {}) {
  const npub = canonicalProfileNpub(identity);
  if (!npub) return Promise.resolve(null);
  if (inFlight.has(npub)) return inFlight.get(npub);
  const promise = (async () => {
    const cached = await getCachedProfile(npub);
    try {
      const profile = await inRelayLane(() => new Promise(resolve => {
        const target = getWorker();
        if (!target) { resolve(null); return; }
        const id = ++nextId;
        const timer = setTimeout(() => { requests.delete(id); resolve(null); }, 30_000);
        requests.set(id, { resolve, timer });
        target.postMessage({ id, npub, options: { force: options.force === true } });
      }));
      return profile || cached;
    } catch { return cached; }
  })().finally(() => inFlight.delete(npub));
  inFlight.set(npub, promise);
  return promise;
}
