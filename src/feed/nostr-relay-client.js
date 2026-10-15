import { EventStore } from 'applesauce-core';
import { RelayPool } from 'applesauce-relay';
import { createAddressLoader, createEventLoader } from 'applesauce-loaders/loaders';
import {
  firstValueFrom,
  takeUntil,
  timer,
  toArray,
  Subject,
  merge,
  tap,
  take,
  filter as rxFilter,
} from 'rxjs';
import { validPublicEvent } from './nostr-normalize.js';
import { notificationRelays, publicNostrRelays } from '../nostr-relays.js';

// One client per worker/identity. This store is ephemeral; durable cards and flags
// remain in Dexie. Public reads never attach a signer or authenticate to relays.
export class NostrRelayClient {
  constructor({ pool = new RelayPool(), diagnostic = () => {} } = {}) {
    this.pool = pool;
    this.diagnostic = diagnostic;
    this.stop = new Subject();
    this.resetCache();
  }
  resetCache() {
    this.addressLoader?.stop();
    this.eventLoader?.stop();
    this.store?.dispose();
    // This short-lived context cache does not manage notification expiry. Avoid
    // scheduling unbounded NIP-40 timers for public events expiring years away.
    this.store = new EventStore({ verifyEvent: validPublicEvent, keepExpired: true });
    const pool = this.pool;
    const upstream = (relays, filters) =>
      pool
        .request(notificationRelays(relays), filters, {
          timeout: 4000,
          reconnect: false,
          waitForAuth: false,
        })
        .pipe(
          rxFilter((event) => validPublicEvent(event)),
          takeUntil(merge(timer(4000), this.stop)),
        );
    const options = { bufferTime: 20, eventStore: this.store };
    this.addressLoader = createAddressLoader(upstream, options);
    this.eventLoader = createEventLoader(upstream, options);
  }
  async query(relays, filter, { first = false } = {}) {
    if (this.disposed) return [];
    let source;
    if (filter.ids?.length === 1) {
      const cached = this.store.getEvent(filter.ids[0]);
      if (cached) return [cached];
      source = this.eventLoader({ id: filter.ids[0], relays });
    } else if (filter.authors?.length === 1 && filter.kinds?.length === 1) {
      const kind = filter.kinds[0],
        pubkey = filter.authors[0];
      const cached = this.store.getReplaceable(kind, pubkey);
      if (cached) return [cached];
      source = this.addressLoader({ kind, pubkey, relays: publicNostrRelays(relays) });
    } else {
      source = this.pool.request(relays, filter, {
        timeout: 4000,
        reconnect: false,
        waitForAuth: false,
      });
    }
    source = source.pipe(rxFilter((event) => validPublicEvent(event)));
    if (first || filter.ids) source = source.pipe(take(1));
    return firstValueFrom(
      source.pipe(
        tap((event) => this.store.add(event)),
        takeUntil(merge(timer(4500), this.stop)),
        toArray(),
      ),
    ).catch(() => []);
  }
  subscribe(relays, filter, handlers) {
    relays = notificationRelays(relays);
    const canonical = (value) => notificationRelays([value])[0];
    const candidates = new Set();
    const completed = new Set(),
      failed = new Set();
    let received = 0,
      settled = false;
    const progress = () =>
      handlers.progress?.({
        completed: completed.size,
        failed: failed.size,
        total: relays.length,
        received,
        settled,
      });
    const subscription = this.pool
      .req(relays, filter, { reconnect: false, waitForAuth: false })
      .subscribe({
        next: (message) => {
          this.diagnostic(message);
          if (message.type === 'EVENT') {
            received++;
            if (
              candidates.size < 500 &&
              !candidates.has(message.event?.id) &&
              validPublicEvent(message.event)
            ) {
              candidates.add(message.event.id);
              this.store.add(message.event, message.from);
              handlers.onevent(message.event);
            }
          } else if (message.type === 'EOSE') {
            completed.add(canonical(message.from));
            failed.delete(canonical(message.from));
          } else if (message.type === 'CLOSED' || message.type === 'ERROR')
            failed.add(canonical(message.from));
          progress();
        },
        error: () => handlers.onclose(),
      });
    const deadline = setTimeout(() => {
      settled = true;
      for (const relay of relays)
        if (!completed.has(canonical(relay))) failed.add(canonical(relay));
      handlers.progress?.({
        completed: completed.size,
        failed: relays.length - completed.size,
        total: relays.length,
        received,
        settled: true,
      });
    }, 8000);
    return {
      close() {
        clearTimeout(deadline);
        subscription.unsubscribe();
      },
    };
  }
  dispose() {
    this.disposed = true;
    this.stop.next();
    this.stop.complete();
    this.addressLoader.stop();
    this.eventLoader.stop();
    this.pool.close();
    this.store.dispose();
  }
}
