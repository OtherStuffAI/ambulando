import Dexie from 'dexie';
import { boundDiagnosticEvents, diagnosticBytes, sanitizeDiagnosticEvent,
  DIAGNOSTICS_AFTERMATH_MS, DIAGNOSTICS_QUEUE_BYTES, DIAGNOSTICS_QUEUE_TTL } from './diagnostics-schema.js';

export function createDiagnosticsDb(name = 'wingman-flightdeck-diagnostics-v1') {
  const db = new Dexie(name);
  db.version(1).stores({ scopes: '&key' });
  return db;
}

export const defaultDiagnosticsSettings = () => ({ enabled: false, automatic: false, channelId: '', agentNpub: '' });

export class DiagnosticsStore {
  constructor(db, now = () => Date.now()) { this.db = db; this.now = now; }

  async mutate(key, fn) {
    if (!key) throw new Error('Diagnostics scope is required');
    return this.db.transaction('rw', this.db.scopes, async () => {
      const row = await this.db.scopes.get(key) || { key, settings: defaultDiagnosticsSettings(), events: [], queue: [], groups: [], revision: 0 };
      const now = this.now();
      row.events = boundDiagnosticEvents(row.events, now);
      row.queue = row.queue.filter(item => now - item.createdAt < DIAGNOSTICS_QUEUE_TTL);
      row.groups = row.groups.filter(item => now - item.at < 60 * 60_000);
      const result = await fn(row, now);
      await this.db.scopes.put(row);
      return result;
    });
  }

  info(key) { return this.mutate(key, row => ({ settings: row.settings, count: row.events.length,
    pending: row.queue.length, lastReport: row.lastReport || null, revision: row.revision })); }

  configure(key, settings) {
    return this.mutate(key, row => {
      const before = row.settings;
      row.settings = { enabled: settings.enabled === true, automatic: settings.enabled === true && settings.automatic === true,
        channelId: String(settings.channelId || '').slice(0, 100), agentNpub: String(settings.agentNpub || '').slice(0, 100) };
      row.revision++;
      if (!row.settings.enabled || before.channelId !== row.settings.channelId || before.agentNpub !== row.settings.agentNpub) row.queue = [];
      else if (!row.settings.automatic) row.queue = row.queue.filter(item => !item.automatic);
      for (const item of row.queue) item.revision = row.revision;
      return { settings: row.settings, revision: row.revision };
    });
  }

  append(key, events) {
    return this.mutate(key, (row, now) => {
      if (!row.settings.enabled) return [];
      const safe = events.slice(0, 100).map(event => sanitizeDiagnosticEvent(event, now)).filter(Boolean);
      row.events = boundDiagnosticEvents([...row.events, ...safe], now);
      return safe;
    });
  }

  queue(key, input) {
    return this.mutate(key, (row, now) => {
      if ((input.automatic && (!row.settings.enabled || !row.settings.automatic)) || (!input.automatic && !row.settings.enabled && input.manualAuthorized !== true)) throw new Error('Diagnostics sending is disabled');
      if (!row.settings.channelId || !row.settings.agentNpub) throw new Error('Choose a report channel and agent');
      const trigger = sanitizeDiagnosticEvent(input.trigger || { ts: now, source: 'ui', level: 'info', code: 'interaction' }, now);
      if (!trigger) throw new Error('Expired incident');
      const fingerprint = JSON.stringify([input.build, trigger.source, trigger.code, trigger.name, trigger.route, trigger.status, trigger.stack]);
      if (input.automatic) {
        const prior = row.groups.find(item => item.fingerprint === fingerprint && now - item.at < 10 * 60_000);
        if (prior) {
          const queued = row.queue.find(item => item.incidentId === prior.id);
          if (queued && !queued.finalized) queued.recurrence++;
          return null;
        }
        if (row.groups.length >= 3) return null;
      }
      if (row.queue.length >= 5) throw new Error('Local report queue is full');
      const item = { version: 1, incidentId: input.incidentId, createdAt: now,
        readyAt: now + (input.automatic ? DIAGNOSTICS_AFTERMATH_MS : 0), automatic: input.automatic === true,
        build: input.build, workspaceId: input.workspaceId, trigger, recurrence: 1,
        description: String(input.description || '').slice(0, 4_000), events: row.settings.enabled ? [...row.events] : [],
        historyAvailable: row.settings.enabled, manualAuthorized: !input.automatic && input.manualAuthorized === true,
        channelId: row.settings.channelId, agentNpub: row.settings.agentNpub, revision: row.revision,
        limitations: ['Evidence excludes free-form logs/messages, payloads, headers, screenshots and comprehensive OS crash dumps.'] };
      if (diagnosticBytes([...row.queue, item]) > DIAGNOSTICS_QUEUE_BYTES) throw new Error('Local report queue size limit reached');
      row.queue.push(item);
      if (input.automatic) row.groups.push({ fingerprint, at: now, id: item.incidentId });
      return item.incidentId;
    });
  }

  next(key) {
    return this.mutate(key, (row, now) => {
      const item = row.queue.find(item => item.readyAt <= now && (item.automatic ? row.settings.enabled && row.settings.automatic : row.settings.enabled || item.manualAuthorized));
      if (!item) return null;
      if (!item.finalized) {
        const seen = new Set(item.events.map(event => JSON.stringify(event)));
        item.events = boundDiagnosticEvents([...item.events, ...(item.historyAvailable ? row.events : []).filter(event => event.ts >= item.createdAt && !seen.has(JSON.stringify(event)))], now);
        item.finalized = true;
      }
      return structuredClone(item);
    });
  }

  patch(key, id, revision, patch) {
    return this.mutate(key, row => {
      const item = row.queue.find(item => item.incidentId === id);
      if (!item || row.revision !== revision || (!row.settings.enabled && (item.automatic || !item.manualAuthorized))) throw new Error('Report consent changed');
      for (const field of ['objectId', 'prepared', 'uploaded', 'host', 'hostEvents', 'hostLimitations']) {
        if (patch[field] !== undefined) item[field] = patch[field];
      }
      if (patch.retry) { item.attempts = (item.attempts || 0) + 1; item.readyAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(item.attempts, 6)); }
      if (patch.sent) { row.queue = row.queue.filter(item => item.incidentId !== id); row.lastReport = { at: this.now(), incidentId: id }; }
      if (diagnosticBytes(row.queue) > DIAGNOSTICS_QUEUE_BYTES) throw new Error('Local report queue size limit reached');
      return true;
    });
  }

  clear(key) { return this.mutate(key, row => { row.events = []; row.queue = []; row.groups = []; row.lastReport = null; row.revision++; return true; }); }

  async prune() {
    const now = this.now();
    await this.db.transaction('rw', this.db.scopes, async () => {
      for (const row of await this.db.scopes.toArray()) {
        row.events = boundDiagnosticEvents(row.events, now);
        row.queue = row.queue.filter(item => now - item.createdAt < DIAGNOSTICS_QUEUE_TTL);
        row.groups = row.groups.filter(item => now - item.at < 60 * 60_000);
        await this.db.scopes.put(row);
      }
    });
  }
}
