import { liveQuery } from 'dexie';
import { getSharedDb, getCachedProfile } from '../db.js';
import { canonicalProfileNpub, profileHex, readableIdentityLabel } from '../profile-identity.js';

// A display-only projection of the existing shared cache, limited to identities
// actually rendered on this canvas. No directory, relay or persistence owner.
export function canvasPersonNames({ database = getSharedDb, profile = getCachedProfile } = {}) {
  const subscriptions = new Map(), scopes = new Map();
  return {
    personNames: {},
    personName(identity, scope = 'canvas') {
      const npub = canonicalProfileNpub(identity);
      try { profileHex(npub); } catch { return 'Unknown person'; }
      if (!scopes.has(scope)) scopes.set(scope, new Set());
      scopes.get(scope).add(npub);
      if (!subscriptions.has(npub)) {
        // Bound retained local projections even while browsing long histories.
        if (subscriptions.size >= 2000) {
          const oldest = subscriptions.keys().next().value;
          subscriptions.get(oldest).unsubscribe(); subscriptions.delete(oldest);
          for (const identities of scopes.values()) identities.delete(oldest);
          const { [oldest]: _removed, ...remaining } = this.personNames; this.personNames = remaining;
        }
        subscriptions.set(npub, liveQuery(async () => {
          const contact = await database().address_book.get(npub);
          const cached = await profile(npub);
          return readableIdentityLabel(contact?.label, cached?.display_name, cached?.name) || 'Unknown person';
        }).subscribe({ next: name => { this.personNames = { ...this.personNames, [npub]: name }; } }));
      }
      return this.personNames[npub] || 'Unknown person';
    },
    releasePersonNames(scope) {
      const released = scopes.get(scope) || [];
      scopes.delete(scope);
      const remaining = { ...this.personNames };
      for (const identity of released) {
        if ([...scopes.values()].some(identities => identities.has(identity))) continue;
        subscriptions.get(identity)?.unsubscribe(); subscriptions.delete(identity); delete remaining[identity];
      }
      this.personNames = remaining;
    },
    stopPersonNames() {
      for (const subscription of subscriptions.values()) subscription.unsubscribe();
      subscriptions.clear(); scopes.clear(); this.personNames = {};
    },
  };
}
