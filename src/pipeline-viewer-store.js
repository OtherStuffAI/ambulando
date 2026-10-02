import { liveQuery } from 'dexie';
import { viewerContextKey, snapshotDto, definitionDto, runDto, REDACTION_REVIEW_REQUIRED } from './pipeline-viewer-contract.js';
export const PIPELINE_VIEWER_STORES = {
  pipeline_viewer_state: '&key', pipeline_viewer_definitions: '&key, context', pipeline_viewer_runs: '&key, context', pipeline_viewer_snapshots: '&key, context',
};
export function createPipelineViewerStore(db, context) {
  const key = viewerContextKey(context);
  const rowKey = id => JSON.stringify([key, id]);
  const tables = Object.keys(PIPELINE_VIEWER_STORES).map(name => db.table(name));
  return {
    key,
    async state(patch, valid = () => true) {
      await db.transaction('rw', db.pipeline_viewer_state, async () => {
        const previous = await db.pipeline_viewer_state.get(key);
        if (!valid()) return;
        if (previous?.reason === REDACTION_REVIEW_REQUIRED) return;
        await db.pipeline_viewer_state.put({ ...previous, ...patch, key });
      });
    },
    async withhold(recoveryRunId) {
      await db.transaction('rw', ...tables, async () => {
        for (const table of tables.slice(1)) await table.where('context').equals(key).delete();
        await db.pipeline_viewer_state.put({ key, status: 'unavailable', stale: false, reason: REDACTION_REVIEW_REQUIRED,
          selectedRunId: '', selectedDefinitionId: '', recoveryRunId });
      });
    },
    async read() {
      const state = await db.pipeline_viewer_state.get(key) || { key, status: 'unloaded', selectedRunId: '', selectedDefinitionId: '' };
      const [definitions, runs, snapshot] = await Promise.all([
        db.pipeline_viewer_definitions.where('context').equals(key).toArray(), db.pipeline_viewer_runs.where('context').equals(key).toArray(),
        state.selectedRunId ? db.pipeline_viewer_snapshots.get(rowKey(state.selectedRunId)) : null,
      ]);
      return { state, definitions: definitions.map(row => row.dto), runs: runs.map(row => row.dto), snapshot: snapshot?.dto || null };
    },
    observe() { return liveQuery(() => this.read()); },
    async page(kind, payload, replace = false, valid = () => true) {
      const table = kind === 'definitions' ? db.pipeline_viewer_definitions : db.pipeline_viewer_runs;
      const rows = payload[kind].map(row => kind === 'definitions' ? definitionDto(row) : runDto(row, context.serviceId));
      await db.transaction('rw', table, db.pipeline_viewer_state, async () => {
        const state = await db.pipeline_viewer_state.get(key);
        if (!valid() || state?.reason === REDACTION_REVIEW_REQUIRED) return;
        if (replace) await table.where('context').equals(key).delete();
        await table.bulkPut(rows.map(dto => ({ key: rowKey(dto.id), context: key, dto })));
        await this.state({ [`${kind}Cursor`]: payload.nextCursor ?? null, status: rows.length || !replace ? 'ready' : 'empty', stale: false });
      });
    },
    async snapshot(payload, expectedRevision, { valid = () => true, authoritative = false } = {}) {
      const dto = snapshotDto(payload, context.serviceId);
      // Captured excerpts can contain private user text, so keep them session-only too.
      for (const step of dto.steps) for (const ref of step.evidence) delete ref.preview;
      return await db.transaction('rw', ...tables, async () => {
        const state = await db.pipeline_viewer_state.get(key);
        const previous = await db.pipeline_viewer_snapshots.get(rowKey(dto.run.id));
        if (!valid() || (state?.reason === REDACTION_REVIEW_REQUIRED && !authoritative)) return false;
        if (expectedRevision !== undefined && (previous?.dto.revision ?? null) !== expectedRevision) return;
        if (previous && typeof dto.revision === 'number' && previous.dto.revision > dto.revision) return;
        await db.pipeline_viewer_snapshots.put({ key: rowKey(dto.run.id), context: key, dto });
        await db.pipeline_viewer_runs.put({ key: rowKey(dto.run.id), context: key, dto: dto.run });
        await db.pipeline_viewer_state.put({ ...state, key, status: 'ready', stale: false, reason: null, recoveryRunId: '', selectedRunId: dto.run.id });
        return true;
      });
    },
    async clear() { await db.transaction('rw', ...tables, async () => { for (const table of tables.slice(1)) await table.where('context').equals(key).delete(); await db.pipeline_viewer_state.delete(key); }); },
  };
}
