import { withNostrActorName } from './nostr-display.js';
import { nip19, SimplePool } from 'nostr-tools';
import { bech32 } from '@scure/base';
import { publicNostrRelays } from '../nostr-relays.js';
import { normalizeNostrNotification, validPublicEvent } from './nostr-normalize.js';

export function zapProviderUrl(profile) {
  try {
    let url;
    if (profile.lud16) {
      const match = /^([^@\s/]+)@([^@\s/]+)$/.exec(profile.lud16);
      if (!match || !/^[a-z0-9.-]+$/i.test(match[2])) return null;
      url = new URL(`https://${match[2]}/.well-known/lnurlp/${encodeURIComponent(match[1])}`);
    } else if (profile.lud06) {
      const decoded = bech32.decode(profile.lud06, 2048);
      if (decoded.prefix !== 'lnurl') return null;
      url = new URL(new TextDecoder().decode(bech32.fromWords(decoded.words)));
    } else return null;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !url.hostname.includes('.') ||
      /(^localhost$|\.(localhost|local|internal)$|^[\d.]+$|:)/i.test(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export class NostrNotificationService {
  constructor({
    recipient,
    relays = [],
    pool = new SimplePool(),
    fetchImpl = fetch,
    emit = () => {},
    status = () => {},
  }) {
    this.recipient = recipient;
    this.relays = publicNostrRelays(relays);
    this.pool = pool;
    this.fetch = fetchImpl;
    this.emit = emit;
    this.status = status;
    this.disposed = false;
    this.seen = new Set();
    this.targets = new Map();
    this.actorProfiles = new Map();
    this.activeValidations = 0;
  }
  async start() {
    const discovery = await Promise.allSettled([
      this.query({ kinds: [10002], authors: [this.recipient], limit: 1 }),
      this.query({ kinds: [0], authors: [this.recipient], limit: 1 }),
    ]);
    if (this.disposed) return;
    const latest = (result, kind) =>
      result.status === 'fulfilled'
        ? result.value
            .filter((e) => validPublicEvent(e) && e.kind === kind && e.pubkey === this.recipient)
            .sort((a, b) => b.created_at - a.created_at)[0]
        : null;
    const relayEvent = latest(discovery[0], 10002),
      profileEvent = latest(discovery[1], 0);
    this.relays = publicNostrRelays(
      relayEvent?.tags.filter((t) => t[0] === 'r' && (!t[2] || t[2] === 'read')).map((t) => t[1]) ||
        this.relays,
    );
    try {
      this.profile = JSON.parse(profileEvent?.content || '{}');
    } catch {
      this.profile = {};
    }
    this.cycle();
  }
  query(filter) {
    return this.pool.querySync(this.relays, filter, { maxWait: 2500 });
  }
  getEvent(id) {
    if (!this.targets.has(id)) {
      if (this.targets.size >= 500 || this.disposed) return Promise.resolve(null);
      this.targets.set(
        id,
        this.query({ ids: [id], limit: 1 })
          .then((events) => events.find((e) => e.id === id && validPublicEvent(e)) || null)
          .catch(() => null),
      );
    }
    return this.targets.get(id);
  }
  getActorName(npub) {
    if (!this.actorProfiles.has(npub)) {
      if (this.actorProfiles.size >= 50 || this.disposed) return Promise.resolve('');
      const pubkey = nip19.decode(npub).data;
      this.actorProfiles.set(
        npub,
        this.query({ kinds: [0], authors: [pubkey], limit: 1 })
          .then((events) => {
            const latest = events
              .filter(
                (event) => event.kind === 0 && event.pubkey === pubkey && validPublicEvent(event),
              )
              .sort((a, b) => b.created_at - a.created_at)[0];
            try {
              const profile = JSON.parse(latest?.content || '{}');
              return profile?.display_name || profile?.name || '';
            } catch {
              return '';
            }
          })
          .catch(() => ''),
      );
    }
    return this.actorProfiles.get(npub);
  }
  getZapProvider() {
    if (!this.provider)
      this.provider = (async () => {
        const url = zapProviderUrl(this.profile);
        if (!url || this.disposed) return null;
        const controller = new AbortController();
        this.providerAbort = controller;
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const response = await this.fetch(url, {
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          });
          if (!response.ok || !response.body) return null;
          const reader = response.body.getReader();
          let size = 0,
            text = '';
          const decoder = new TextDecoder();
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.length;
              if (size > 65536) return null;
              text += decoder.decode(part.value, { stream: true });
            }
          } finally {
            await reader.cancel();
          }
          const body = JSON.parse(text + decoder.decode());
          return body.allowsNostr === true && /^[a-f0-9]{64}$/.test(body.nostrPubkey)
            ? body.nostrPubkey
            : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })();
    return this.provider;
  }
  cycle() {
    if (this.disposed) return;
    // Finish the retained burst before rotating; slow target/profile lookups must
    // not discard queued notifications at the five-minute boundary.
    if (this.activeValidations || this.queue?.length) {
      this.timer = setTimeout(() => this.cycle(), 10000);
      return;
    }
    const generation = (this.generation = (this.generation || 0) + 1);
    this.subscription?.close();
    this.targets.clear();
    this.actorProfiles.clear();
    this.seen.clear();
    this.providerAbort?.abort();
    this.provider = null;
    let processed = 0,
      pending = 0;
    const queue = (this.queue = []);
    const drain = () => {
      while (!this.disposed && this.generation === generation && pending < 4 && queue.length) {
        const event = queue.shift();
        pending++;
        this.activeValidations++;
        normalizeNostrNotification(event, this.recipient, {
          getEvent: (id) => this.getEvent(id),
          getZapProvider: () => this.getZapProvider(),
        })
          .then(async (row) => {
            if (!row || this.disposed || this.generation !== generation) return;
            const name = await this.getActorName(row.actorNpub);
            if (!this.disposed && this.generation === generation)
              this.emit(withNostrActorName(row, name));
          })
          .catch(() => {})
          .finally(() => {
            pending--;
            this.activeValidations--;
            drain();
          });
      }
    };
    this.status('Connecting to public Nostr relays…');
    this.subscription = this.pool.subscribeMany(
      this.relays,
      {
        kinds: [1, 6, 7, 16, 9735],
        '#p': [this.recipient],
        since: Math.floor(Date.now() / 1000) - 7 * 86400,
        limit: 200,
      },
      {
        maxWait: 5000,
        oneose: () => {
          if (!this.disposed && this.generation === generation)
            this.status('Public Nostr · recent 7 days');
        },
        onclose: () => {
          if (!this.disposed && this.generation === generation)
            this.status('Nostr relays unavailable. Cached notifications remain; refresh to retry.');
        },
        onevent: (event) => {
          if (
            this.disposed ||
            this.generation !== generation ||
            processed >= 500 ||
            !event ||
            event.created_at < Math.floor(Date.now() / 1000) - 7 * 86400 ||
            this.seen.has(event.id)
          )
            return;
          this.seen.add(event.id);
          processed++;
          queue.push(event);
          drain();
          if (processed === 500) {
            this.subscription?.close();
            this.status('Nostr activity limit reached. Refresh for another recent window.');
          }
        },
      },
    );
    this.timer = setTimeout(() => this.cycle(), 5 * 60 * 1000);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.providerAbort?.abort();
    this.subscription?.close();
    this.pool.close(this.relays);
    this.pool.destroy?.();
    this.targets.clear();
    this.actorProfiles.clear();
    this.seen.clear();
  }
}
