import { getSharedDb } from './db.js';

function text(value) {
  return String(value ?? '').trim();
}

export function nstackSelectionPartition(origin, identity, workspacePartition = 'unbound') {
  const normalizedOrigin = text(origin);
  const normalizedIdentity = text(identity).toLowerCase();
  const normalizedWorkspace = text(workspacePartition) || 'unbound';
  if (!normalizedOrigin || !normalizedIdentity) {
    throw new Error('NStack selection requires an origin and Nostr identity.');
  }
  return `${normalizedOrigin}\n${normalizedIdentity}\n${normalizedWorkspace}`;
}

function sanitizeSelection(selection = {}) {
  const stackId = text(selection.stackId);
  const workspaceId = text(selection.workspaceId);
  if (!stackId || !workspaceId) throw new Error('Choose an NStack and workspace.');
  return {
    stackId,
    stackLabel: text(selection.stackLabel),
    workspaceId,
    workspaceLabel: text(selection.workspaceLabel),
  };
}

export async function loadNStackSelection({ origin, identity, workspacePartition, db = getSharedDb() }) {
  const partition = nstackSelectionPartition(origin, identity, workspacePartition);
  const row = await db.nstack_selections.get(partition);
  if (!row) return null;
  return sanitizeSelection(row);
}

export async function saveNStackSelection({ origin, identity, workspacePartition, selection, db = getSharedDb() }) {
  const partition = nstackSelectionPartition(origin, identity, workspacePartition);
  const sanitized = sanitizeSelection(selection);
  await db.nstack_selections.put({
    partition,
    origin: text(origin),
    identity: text(identity).toLowerCase(),
    ...sanitized,
    updated_at: new Date().toISOString(),
  });
  return sanitized;
}

export async function clearNStackSelection({ origin, identity, workspacePartition, db = getSharedDb() }) {
  await db.nstack_selections.delete(nstackSelectionPartition(origin, identity, workspacePartition));
}
