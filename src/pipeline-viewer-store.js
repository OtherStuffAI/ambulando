import { liveQuery } from 'dexie';
import { viewerContextKey, snapshotDto, definitionDto, runDto } from './pipeline-viewer-contract.js';
export const PIPELINE_VIEWER_STORES = {
  pipeline_viewer_state: '&key', pipeline_viewer_definitions: '&key, context', pipeline_viewer_runs: '&key, context', pipeline_viewer_snapshots: '&key, context',
};
export function createPipelineViewerStore(db, context) {
  const key = viewerContextKey(context);
  const rowKey = id => JSON.stringify([key, id]);
  const tables = Object.keys(PIPELINE_VIEWER_STORES).map(name => db.table(name));
  return {
    key,
    async state(patch) { await db.pipeline_viewer_state.put({ ...(await db.pipeline_viewer_state.get(key)), ...patch, key }); },
    async read() {
      const state = await db.pipeline_viewer_state.get(key) || { key, status: 'unloaded', selectedRunId: '', selectedDefinitionId: '' };
      const [definitions, runs, snapshot] = await Promise.all([
        db.pipeline_viewer_definitions.where('context').equals(key).toArray(), db.pipeline_viewer_runs.where('context').equals(key).toArray(),
        state.selectedRunId ? db.pipeline_viewer_snapshots.get(rowKey(state.selectedRunId)) : null,
      ]);
      return { state, definitions: definitions.map(row => row.dto), runs: runs.map(row => row.dto), snapshot: snapshot?.dto || null };
    },
    observe() { return liveQuery(() => this.read()); },
    async page(kind, payload, replace = false) {
      const table = kind === 'definitions' ? db.pipeline_viewer_definitions : db.pipeline_viewer_runs;
      const rows = payload[kind].map(row => kind === 'definitions' ? definitionDto(row) : runDto(row, context.serviceId));
      await db.transaction('rw', table, db.pipeline_viewer_state, async () => {
        if (replace) await table.where('context').equals(key).delete();
        await table.bulkPut(rows.map(dto => ({ key: rowKey(dto.id), context: key, dto })));
        await this.state({ [`${kind}Cursor`]: payload.nextCursor ?? null, status: rows.length || !replace ? 'ready' : 'empty', stale: false });
      });
    },
    async snapshot(payload, expectedRevision) {
      const dto = snapshotDto(payload, context.serviceId);
      await db.transaction('rw', ...tables, async () => {
        const previous = await db.pipeline_viewer_snapshots.get(rowKey(dto.run.id));
        if (expectedRevision !== undefined && (previous?.dto.revision ?? null) !== expectedRevision) return;
        if (previous && typeof dto.revision === 'number' && previous.dto.revision > dto.revision) return;
        await db.pipeline_viewer_snapshots.put({ key: rowKey(dto.run.id), context: key, dto });
        await db.pipeline_viewer_runs.put({ key: rowKey(dto.run.id), context: key, dto: dto.run });
        await this.state({ status: 'ready', stale: false });
      });
    },
    async clear() { await db.transaction('rw', ...tables, async () => { for (const table of tables.slice(1)) await table.where('context').equals(key).delete(); await db.pipeline_viewer_state.delete(key); }); },
  };
}
