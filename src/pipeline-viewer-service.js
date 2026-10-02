import { createAutopilotDiscoveryClient } from './autopilot-connect-client.js';
import { createPipelineViewerClient } from './pipeline-viewer-client.js';
import { PipelineViewerError, evidenceDto, viewerFailure, isRedactionReviewRefusal, REDACTION_REVIEW_REQUIRED } from './pipeline-viewer-contract.js';

// Network, cancellation and recovery live here; Alpine observes only Dexie rows.
export function createPipelineViewerService({ client, store, connection, pollMs = 2500, schedule = setTimeout, unschedule = clearTimeout }) {
  let generation = 0, disposed = false, timer, runId = '', definitionId = '', refreshing = null;
  let withheld = false;
  const controllers = new Map();
  const evidenceRequests = new Map();
  const previews = new Map();
  const values = new Map(); // Explicit session-only private cache; never passed to store.
  const listeners = new Set();
  const emit = () => listeners.forEach(listener => listener());
  function abort() {
    generation++; unschedule(timer); timer = null;
    for (const [controller] of controllers) controller.abort();
    controllers.clear(); evidenceRequests.clear(); values.clear(); previews.clear(); emit();
  }
  async function perform(operation, options, apply) {
    if (disposed) return;
    const epoch = generation, controller = new AbortController();
    controllers.set(controller,operation);
    try {
      const payload = await client.read(operation, options, controller.signal);
      if (disposed || epoch !== generation || controller.signal.aborted) return;
      return await apply(payload, () => !disposed && epoch === generation && !controller.signal.aborted);
    } catch (error) {
      if (disposed || epoch !== generation || controller.signal.aborted) return;
      if (isRedactionReviewRefusal(error)) {
        withheld = true; abort();
        await store.withhold(runId);
        return false;
      }
      for (const [pending] of controllers) if(pending!==controller)pending.abort();
      values.clear(); previews.clear(); emit();
      const status = viewerFailure(error);
      if (!withheld && (status === 'denied' || status === 'unavailable')) await store.clear();
      await store.state({ status, stale: status === 'disconnected', selectedRunId: runId, selectedDefinitionId: definitionId });
    } finally { controllers.delete(controller); }
  }
  async function authorize() {
    const epoch = generation;
    if (disposed) return false;
    const saved = await store.read();
    if (disposed || epoch !== generation) return false;
    withheld = withheld || saved.state.reason === REDACTION_REVIEW_REQUIRED;
    if (withheld) runId = saved.state.recoveryRunId || runId;
    if (!connection) return !disposed;
    const controller=new AbortController();controllers.set(controller,'health');
    try {await connection.health(controller.signal);return !disposed&&epoch===generation&&!controller.signal.aborted;}
    catch(error){if(disposed||epoch!==generation||controller.signal.aborted)return false;abort();if(isRedactionReviewRefusal(error)){withheld=true;await store.withhold(runId);return false;}const status=viewerFailure(error);if(!withheld&&['denied','unavailable'].includes(status))await store.clear();await store.state({status,stale:status==='disconnected'});return false;}
    finally{controllers.delete(controller);}
  }
  async function refreshSnapshot(recover = false) {
    if (!runId || disposed) return;
    unschedule(timer);
    const id = runId, epoch = generation;
    const existing = await store.read();
    if (epoch !== generation || disposed) return;
    await perform(recover ? 'run' : 'updates', { id, after: existing.snapshot?.revision ?? 0 }, async (payload, valid) => {
      if (payload.run?.id !== id) throw new PipelineViewerError('response_invalid', 'The snapshot did not match the selected run.');
      if (!payload.unchanged) {
        const committed = await store.snapshot(payload, existing.snapshot?.revision ?? null, { valid, authoritative: recover });
        if (!committed || !valid()) return false;
        withheld = false;
        previews.clear();for(const step of payload.steps||[])for(const row of step.evidence||[]){const ref=evidenceDto(row);if(ref.preview)previews.set(ref.id,ref.preview);}emit();
        return true;
      }
      else if (!withheld) await store.state({ status: 'ready', stale: false }, valid);
    });
    if (epoch === generation && !disposed && !withheld && runId === id) {
      const current = await store.read();
      if (current.state.status === 'disconnected' || (current.state.status === 'ready' && !current.snapshot?.run.completedAt && !['ok', 'error', 'completed', 'failed', 'cancelled', 'canceled'].includes(current.snapshot?.run.status))) timer = schedule(() => { void refresh(current.state.status === 'disconnected'); }, pollMs);
    }
  }
  function refresh(recover = false) {
    if (refreshing?.epoch === generation) return refreshing.promise;
    const epoch = generation;
    const promise = refreshSnapshot(recover).finally(() => { if (refreshing?.epoch === epoch) refreshing = null; });
    refreshing = { epoch, promise };
    return promise;
  }
  return {
    get withheld() { return withheld; },
    get disposed() { return disposed; },
    subscribeValues(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    value(id) { return values.get(id) || null; },
    preview(id) { return previews.get(id) || null; },
    initialize: authorize,
    async start() {
      const saved = await store.read();
      if (disposed) return;
      if (saved.state.reason === REDACTION_REVIEW_REQUIRED) { withheld = true; runId = saved.state.recoveryRunId || ''; return; }
      runId = saved.state.selectedRunId || ''; definitionId = saved.state.selectedDefinitionId || '';
      await this.list('definitions');
      await this.list('runs');
      if (runId) await this.selectRun(runId);
    },
    async list(kind, cursor = null) {
      if (withheld || !['definitions', 'runs'].includes(kind)) return;
      await store.state({ status: 'loading' });
      await perform(kind, { ...(cursor ? { cursor } : {}), ...(definitionId && kind === 'runs' ? { definitionId } : {}) }, (payload, valid) => store.page(kind, payload, !cursor, valid));
    },
    async selectDefinition(id) {
      if (withheld) return false;
      abort(); runId = ''; definitionId = id;
      await store.state({ selectedRunId: '', selectedDefinitionId: id, status: 'loading' });
      await perform('definition', { id }, (payload, valid) => store.page('definitions', { definitions: [payload.definition], nextCursor: null }, false, valid));
      await this.list('runs');
    },
    async selectRun(id) {
      abort(); runId = id;
      await store.state({ selectedRunId: id, status: 'loading', stale: false });
      await refresh(true);
    },
    async recover() { if(!await authorize())return;for(const [controller,operation] of controllers)if(operation==='evidence')controller.abort(); values.clear(); emit(); if(runId) await refresh(true); else {await this.list('definitions');await this.list('runs');} },
    async evidence(reference, append = false) {
      if (disposed || withheld || reference.runId !== runId) return;
      if(['not_captured','expired','oversized','unavailable'].includes(reference.availability)){values.set(reference.id,{reference,status:'unavailable',complete:false,nextOffset:null});emit();return;}
      if(evidenceRequests.has(reference.id))return evidenceRequests.get(reference.id);
      if(!append && values.get(reference.id)?.status==='ready')return values.get(reference.id);
      const old = append ? values.get(reference.id) : null;
      const offset = old?.nextOffset ?? 0;
      if (append && old?.nextOffset == null) return;
      const epoch = generation;
      values.set(reference.id, { ...(old || {}), status: 'loading', complete:false, reference }); emit();
      const request = perform('evidence', { id: runId, evidenceId: reference.id, offset, limit: 100 }, payload => {
        const ref = evidenceDto(payload.evidence);
        if (!Object.hasOwn(payload, 'value') || ref.id !== reference.id || ref.runId !== runId || ref.stepId !== reference.stepId || ref.attempt !== reference.attempt
          || (payload.nextOffset != null && (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset))
          || (payload.nextOffset != null && (!Array.isArray(payload.value) || !payload.value.length || payload.nextOffset !== offset + payload.value.length))) throw new PipelineViewerError('response_invalid', 'Evidence identity or pagination did not match the requested value.');
        const value = old && Array.isArray(old.value) && Array.isArray(payload.value) ? [...old.value, ...payload.value] : payload.value;
        values.set(ref.id, { reference: ref, value, nextOffset: payload.nextOffset ?? null,
          status: 'ready', complete: ['complete', 'redacted'].includes(ref.availability) && payload.nextOffset == null }); emit();
      });
      evidenceRequests.set(reference.id,request);
      try{await request;}finally{if(evidenceRequests.get(reference.id)===request)evidenceRequests.delete(reference.id);}
      if (epoch !== generation) return;
    },
    clearValues() { for(const [controller,operation] of controllers)if(operation==='evidence')controller.abort();evidenceRequests.clear();values.clear(); emit(); },
    dispose() { disposed = true; abort(); listeners.clear();void connection?.disconnect?.(); },
  };
}

export function createPipelineViewerSession({verified,context,store,deps={}}) {
  const connection=(deps.createConnection||createAutopilotDiscoveryClient)(verified);
  const client=(deps.createClient||createPipelineViewerClient)(connection,context);
  return (deps.createService||createPipelineViewerService)({client,store,connection});
}
