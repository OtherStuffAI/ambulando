import { NostrNotificationService } from '../feed/nostr-service.js';
let service;
self.onmessage = ({ data }) => {
  service?.dispose();
  if (data.action !== 'start') return;
  self.postMessage({ phase: 'discovery', status: 'Discovering public Nostr relays…' });
  try {
    service = new NostrNotificationService({
      recipient: data.recipient,
      relays: data.relays,
      emit: (row) => self.postMessage({ row }),
      status: (status) => self.postMessage({ status }),
      ready: () => self.postMessage({ phase: 'listening' }),
    });
    service.start().catch(() =>
      self.postMessage({ phase: 'listening', status: 'Nostr unavailable. Refresh to retry.' }),
    );
  } catch {
    self.postMessage({ phase: 'listening', status: 'Nostr unavailable. Refresh to retry.' });
  }
};
self.postMessage({ phase: 'ready' });
