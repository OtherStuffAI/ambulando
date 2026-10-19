import { SimplePool } from 'nostr-tools';
import { publicNostrRelays } from './nostr-relays.js';
import { NSTACK_RECOVERY_KIND } from './nstack-recovery.js';

export function nstackRecoveryRelayUrls(configured = []) {
  return publicNostrRelays(configured).slice(0, 4);
}

export function createNStackRecoveryRepository({ poolFactory = () => new SimplePool(), maxWait = 3000 } = {}) {
  return {
    async list({ relays, author, dValues }) {
      const relayUrls = nstackRecoveryRelayUrls(relays);
      if (relayUrls.length === 0) throw new Error('No valid NStack recovery relays are configured.');
      const pool = poolFactory();
      try {
        return await pool.querySync(relayUrls, {
          kinds: [NSTACK_RECOVERY_KIND],
          authors: [String(author || '').trim().toLowerCase()],
          '#d': [...new Set((dValues || []).filter(Boolean))],
        }, { maxWait }) || [];
      } finally {
        if (typeof pool.close === 'function') pool.close(relayUrls);
      }
    },

    async publish({ relays, event }) {
      const relayUrls = nstackRecoveryRelayUrls(relays);
      if (relayUrls.length === 0) throw new Error('No valid NStack recovery relays are configured.');
      const pool = poolFactory();
      try {
        const results = await Promise.allSettled(pool.publish(relayUrls, event, { maxWait }));
        const accepted = relayUrls.filter((_, index) => results[index]?.status === 'fulfilled');
        if (accepted.length === 0) throw new Error('No relay accepted the encrypted NStack recovery record.');
        return { accepted, failed: relayUrls.filter(relay => !accepted.includes(relay)) };
      } finally {
        if (typeof pool.close === 'function') pool.close(relayUrls);
      }
    },
  };
}
