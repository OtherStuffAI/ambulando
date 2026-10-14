import { NostrNotificationService } from '../feed/nostr-service.js';
let service;
self.onmessage = ({ data }) => {
  service?.dispose();
  if (data.action !== 'start') return;
  service = new NostrNotificationService({
    recipient: data.recipient,
    relays: data.relays,
    emit: (row) => self.postMessage({ row }),
    status: (status) => self.postMessage({ status }),
  });
  service.start().catch(() => self.postMessage({ status: 'Nostr unavailable. Refresh to retry.' }));
};
