import { exportTowerTransports, initializeTowerTransports, suspendTowerTransports } from './tower-transport.js';
import { refreshNativeSyncWorkerTransport } from './sync-worker-client.js';

// A new native document provider cannot reuse its predecessor's grants/ports.
// Recovery only repairs transport; TowerSyncService owns the subsequent sync.
export function installNativeTransportLifecycle({
  windowObject = globalThis.window,
  hasFips = () => exportTowerTransports().some(row => row.mode === 'fips'),
  suspend = suspendTowerTransports,
  initialize = initializeTowerTransports,
  refreshWorker = refreshNativeSyncWorkerTransport,
} = {}) {
  if (!windowObject?.addEventListener) return () => {};
  let provider = windowObject.fipsTransport;
  let generation = 0;
  let disposed = false;
  const revoke = () => {
    generation++;
    suspend();
  };
  const ready = async () => {
    const next = windowObject.fipsTransport;
    if (disposed || next === provider) return;
    provider = next;
    if (!hasFips()) return;
    revoke();
    const current = generation;
    try {
      await initialize({ transport: next });
      if (disposed || current !== generation) return;
      refreshWorker();
      windowObject.dispatchEvent(new Event('focus'));
    } catch {
      // Retain the selected unavailable FIPS state; never switch to HTTPS.
    }
  };
  windowObject.addEventListener('wingman-fips-transport-revoked', revoke);
  windowObject.addEventListener('wingman-fips-transport-ready', ready);
  return () => {
    disposed = true;
    generation++;
    windowObject.removeEventListener('wingman-fips-transport-revoked', revoke);
    windowObject.removeEventListener('wingman-fips-transport-ready', ready);
  };
}
