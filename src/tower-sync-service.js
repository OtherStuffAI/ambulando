/**
 * Workspace-scoped ownership seam for Tower reads and live synchronization.
 *
 * Stage 1 deliberately delegates to the existing PG hydrator, sync manager,
 * and worker client. Later stages move those implementations behind these
 * ports without changing the UI-facing lifecycle again.
 */
export class TowerSyncService {
  constructor({ workspaceKey, ports = {}, families = {}, onStateChange = null } = {}) {
    const key = String(workspaceKey || '').trim();
    if (!key) throw new Error('TowerSyncService requires a workspace key');
    this.workspaceKey = key;
    this.ports = ports;
    this.families = new Map(Object.entries(families || {}));
    this.familyFreshAt = new Map();
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this.fallbackTimer = null;
    this.disposed = false;
    this.readAbortController = new AbortController();
    this.started = false;
    this.inFlight = new Map();
    this.commandGenerations = new Map();
    this.completedCommands = new Map();
    this.feedCommandRequests = new Map();
    this.instrumentation = {
      workspaceKey: key,
      sseOwners: 0,
      fallbackTimers: 0,
      coalescedRequests: 0,
      commandsStarted: 0,
      commandsCoalesced: 0,
      commandsAcknowledged: 0,
      commandsFailed: 0,
      staleAcknowledgements: 0,
      materialisationsStarted: 0,
      materialisationsCommitted: 0,
      materialisationsFailed: 0,
      disposed: false,
    };
  }

  start({ runSoon = false } = {}) {
    this.assertActive();
    if (!this.started) {
      this.started = true;
      this.instrumentation.sseOwners = 1;
      this.ports.startFlushTimer?.();
    }
    // The existing SSE adapter is idempotent and still owns token minting.
    this.ports.connectSSE?.({ runSoon });
    this.scheduleFallback(runSoon ? 50 : null);
    this.emitState();
    return this;
  }

  scheduleFallback(delayMs = null) {
    this.assertActive();
    this.clearFallbackTimer();
    const cadence = delayMs ?? this.ports.getFallbackCadence?.();
    if (!cadence) return false;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.instrumentation.fallbackTimers = 0;
      this.emitState();
      void this.ports.runFallbackPoll?.();
    }, cadence);
    this.instrumentation.fallbackTimers = 1;
    this.emitState();
    return true;
  }

  async hydrateInitial(options = {}) {
    return this.coalesce('hydrate:workspace', () => this.ports.hydrateInitial?.(options));
  }

  async ensureLoaded(family, id = '', options = {}) {
    const familyKey = String(family || '').trim();
    if (!familyKey) throw new Error('ensureLoaded requires a family');
    const recordKey = String(id || '').trim();
    if (this.ports.canLoad && !await this.ports.canLoad(familyKey, recordKey, options)) return { archived: true, family: familyKey, id: recordKey };
    const registration = this.families.get(familyKey);
    const freshnessKey = `${familyKey}:${recordKey}`;
    const freshMs = Number(options.freshMs ?? registration?.freshMs ?? 0);
    if (options.force !== true && freshMs > 0) {
      const loadedAt = Number(this.familyFreshAt.get(freshnessKey) || 0);
      if (loadedAt && Date.now() - loadedAt < freshMs) {
        return { fresh: true, family: familyKey, id: recordKey };
      }
    }
    return this.coalesce(`ensure:${familyKey}:${recordKey}`, async () => {
      const load = registration?.load || this.ports.ensureLoaded;
      const payload = registration
        ? await load(recordKey, options)
        : await load?.(familyKey, recordKey, options);
      this.assertActive();
      const result = registration?.materialize
        ? await registration.materialize(payload, { id: recordKey, options })
        : payload;
      this.assertActive();
      if (registration?.trackFreshness !== false) this.familyFreshAt.set(freshnessKey, Date.now());
      return result;
    });
  }

  async recoverCursor(input = {}) {
    const cursor = String(input?.cursor || input?.reason || 'current');
    return this.coalesce(`recover:${cursor}`, () => this.ports.recoverCursor?.(input));
  }

  async materialize(family, payload, options = {}) {
    this.assertActive();
    this.instrumentation.materialisationsStarted += 1;
    this.emitState();
    try {
      const result = await this.ports.materialize?.(family, payload, options);
      this.assertActive();
      this.instrumentation.materialisationsCommitted += 1;
      this.emitState();
      return result;
    } catch (error) {
      this.instrumentation.materialisationsFailed += 1;
      this.emitState();
      throw error;
    }
  }

  async freshness(family, id = '') {
    this.assertActive();
    return this.ports.freshness?.(family, id);
  }

  async command(name, input = {}, options = {}) {
    this.assertActive();
    const commandName = String(name || '').trim();
    if (!commandName) throw new Error('command requires a name');
    const mutationId = String(
      options.clientMutationId
      || input.clientMutationId
      || input.client_mutation_id
      || input.localRow?.record_id
      || input.record_id
      || '',
    ).trim();
    const commandKey = mutationId ? `${commandName}:${mutationId}` : '';
    if (commandKey && commandName.startsWith('feed')) {
      const fingerprint = JSON.stringify(input.body);
      const previous = this.feedCommandRequests.get(commandKey);
      if (previous && previous !== fingerprint) throw new Error('mutation_id_reused');
      this.feedCommandRequests.set(commandKey, fingerprint);
    }
    if (commandKey && this.completedCommands.has(commandKey)) {
      return this.completedCommands.get(commandKey);
    }
    if (commandKey && this.inFlight.has(`command:${commandKey}`)) {
      this.instrumentation.commandsCoalesced += 1;
      this.emitState();
      return this.inFlight.get(`command:${commandKey}`);
    }

    const prepare = this.ports.prepareCommand;
    if (typeof prepare !== 'function') throw new Error(`Tower command port is not registered for ${commandName}`);
    const descriptor = prepare(commandName, input, options);
    if (!descriptor || typeof descriptor.execute !== 'function') {
      throw new Error(`Tower command is not registered for ${commandName}`);
    }
    const entityKey = String(descriptor.entityKey || commandKey || commandName);
    const generation = (this.commandGenerations.get(entityKey) || 0) + 1;
    this.commandGenerations.set(entityKey, generation);
    this.instrumentation.commandsStarted += 1;
    this.emitState();

    const run = (async () => {
      await descriptor.optimistic?.();
      this.assertActive();
      try {
        const acknowledgement = await descriptor.execute();
        this.assertActive();
        if (this.commandGenerations.get(entityKey) !== generation) {
          this.instrumentation.staleAcknowledgements += 1;
          this.emitState();
          return { stale: true, acknowledgement };
        }
        const result = await descriptor.reconcile?.(acknowledgement) ?? acknowledgement;
        this.assertActive();
        this.instrumentation.commandsAcknowledged += 1;
        if (commandKey) this.completedCommands.set(commandKey, result);
        this.emitState();
        return result;
      } catch (error) {
        if (!this.disposed && this.commandGenerations.get(entityKey) === generation) {
          await descriptor.fail?.(error);
          this.instrumentation.commandsFailed += 1;
          this.emitState();
        }
        throw error;
      }
    })();
    if (commandKey) {
      const inFlightKey = `command:${commandKey}`;
      this.inFlight.set(inFlightKey, run);
      run.finally(() => {
        if (this.inFlight.get(inFlightKey) === run) this.inFlight.delete(inFlightKey);
      }).catch(() => {});
    }
    return run;
  }

  coalesce(key, request) {
    this.assertActive();
    const existing = this.inFlight.get(key);
    if (existing) {
      this.instrumentation.coalescedRequests += 1;
      this.emitState();
      return existing;
    }
    const pending = Promise.resolve().then(request);
    this.inFlight.set(key, pending);
    pending.then(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }, () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    return pending;
  }

  async prepareTransportReload() {
    this.assertActive();
    this.clearFallbackTimer();
    this.ports.disconnectSSE?.({ reason: 'transport-reload' });
    this.ports.stopFlushTimer?.();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  dispose(reason = 'dispose') {
    if (this.disposed) return;
    this.disposed = true;
    this.readAbortController.abort();
    this.clearFallbackTimer();
    this.ports.disconnectSSE?.({ reason });
    this.ports.stopFlushTimer?.();
    this.ports.disposeMaterializer?.({ reason });
    this.started = false;
    this.familyFreshAt.clear();
    this.commandGenerations.clear();
    this.completedCommands.clear();
    this.feedCommandRequests.clear();
    this.instrumentation.sseOwners = 0;
    this.instrumentation.disposed = true;
    this.instrumentation.disposeReason = reason;
    this.emitState();
  }

  snapshot() {
    return { ...this.instrumentation, inFlightRequests: this.inFlight.size };
  }

  clearFallbackTimer() {
    if (this.fallbackTimer != null) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    this.instrumentation.fallbackTimers = 0;
  }

  assertActive() {
    if (this.disposed) throw new Error(`TowerSyncService for ${this.workspaceKey} is disposed`);
  }

  emitState() {
    this.onStateChange?.(this.snapshot());
  }
}

export function replaceTowerSyncService(current, options) {
  const workspaceKey = String(options?.workspaceKey || '').trim();
  if (current?.workspaceKey === workspaceKey && !current.disposed) return current;
  current?.dispose('workspace-owner-replaced');
  return new TowerSyncService(options);
}
