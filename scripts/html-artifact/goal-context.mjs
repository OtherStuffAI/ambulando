// Ambulando application references over existing NStack records. No source content is copied into output metadata.
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = 'application/vnd.ambulando.goal+json';
const MAX_BYTES = 256 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const active = row => row && !row.deleted_at && !row.archived_at && !['deleted', 'archived'].includes(row.record_state);
const origin = value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid goal context backend'); return url.href.replace(/\/+$/, ''); };

export function primaryGoalReference(value) {
  if (!object(value) || value.version !== 1 || !UUID.test(String(value.goal_file_id || ''))) throw new Error('Unsupported or malformed primary goal association');
  return { version: 1, goal_file_id: value.goal_file_id.toLowerCase() };
}

/** Reads only supported session context. Explicit routing is a source record reference, never a source snapshot. */
export async function publisherThreadRoute({ workspaceId, baseUrl, readContext, chatThreadId }) {
  if (!UUID.test(String(workspaceId))) throw new Error('Publication workspace must be a UUID');
  if (chatThreadId !== undefined) {
    if (!UUID.test(String(chatThreadId))) throw new Error('--chat-thread must be a thread UUID');
    return { threadId: chatThreadId.toLowerCase(), channelId: null };
  }
  const context = await readContext?.();
  if (!context) return null; // Standalone publication outside an agent session.
  if (context.ok === false) throw new Error('Authoritative session context is unavailable');
  const threadId = context.chat?.threadId || context.routing?.threadId;
  if (!threadId) return null; // A successful context read can establish that this session has no originating chat.
  const workspace = object(context.workspace);
  if (!workspace || workspace.workspaceId !== workspaceId || origin(workspace.backendBaseUrl) !== origin(baseUrl)) throw new Error('Current session goal context does not match the publication workspace/backend; pass --chat-thread explicitly');
  const channelId = context.chat?.channelId || context.routing?.channelId;
  if (!UUID.test(String(threadId)) || !UUID.test(String(channelId))) throw new Error('Current session has an invalid chat route');
  return { threadId: threadId.toLowerCase(), channelId: channelId.toLowerCase() };
}

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function validGoal(goal) {
  if (!object(goal) || goal.schema !== 'ambulando.goal' || goal.schema_version !== 1 || typeof goal.name !== 'string' || !goal.name.trim() || goal.name.length > 120 || typeof goal.description !== 'string' || !goal.description.trim() || goal.description.length > 2000 || !['active', 'completed', 'archived'].includes(goal.status)) return false;
  if ([goal.start_date, goal.target_date].some(value => value != null && !validDate(value)) || (goal.start_date && goal.target_date && goal.target_date < goal.start_date)) return false;
  if (goal.default_channel_id != null && !UUID.test(String(goal.default_channel_id))) return false;
  for (const [key, limit] of [['links', 500], ['pinned_refs', 100]]) {
    const refs = goal[key] ?? [];
    if (!Array.isArray(refs) || refs.length > limit || new Set(refs.map(ref => `${ref?.type}:${ref?.record_id}`)).size !== refs.length) return false;
    if (refs.some(ref => !object(ref) || !(key === 'pinned_refs' ? ['doc', 'file'] : ['chat', 'task', 'doc', 'file']).includes(ref.type) || !UUID.test(String(ref.record_id)) || (ref.channel_id != null && !UUID.test(String(ref.channel_id))))) return false;
  }
  const checkpoints = goal.checkpoints ?? [];
  return Array.isArray(checkpoints) && checkpoints.length <= 100 && new Set(checkpoints.map(cp => cp?.id)).size === checkpoints.length && checkpoints.every(cp => object(cp) && /^[A-Za-z0-9_-]{1,64}$/.test(cp.id) && typeof cp.title === 'string' && cp.title.trim() && cp.title.length <= 120 && (cp.reached == null || typeof cp.reached === 'boolean') && (cp.description == null || (typeof cp.description === 'string' && cp.description.length <= 500)) && (cp.date == null || validDate(cp.date)));
}

/** A denied Goal read preserves only an authoritative identity; accessible invalid/missing sources fail closed. */
export async function resolvePublisherGoal(client, { workspaceId, baseUrl, readContext, chatThreadId }) {
  const route = await publisherThreadRoute({ workspaceId, baseUrl, readContext, chatThreadId });
  if (!route) return null;
  const root = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}`;
  const thread = (await client.request('GET', `${root}/threads/${route.threadId}`))?.thread;
  if (!active(thread) || thread.id !== route.threadId || thread.workspace_id !== workspaceId || !UUID.test(String(thread.channel_id)) || (route.channelId && thread.channel_id !== route.channelId)) throw new Error('Authoritative chat identity or access is unavailable');
  const raw = thread.metadata?.ambulando_goal;
  if (raw === undefined) return null;
  const reference = primaryGoalReference(raw);
  let file;
  try { file = (await client.getFile(reference.goal_file_id))?.file; }
  catch (error) { if (error.status === 403) return reference; throw error; }
  if (!active(file) || file.id !== reference.goal_file_id || file.workspace_id !== workspaceId || String(file.content_type).split(';')[0].trim().toLowerCase() !== MIME || file.metadata?.goal?.schema_version !== 1 || !UUID.test(String(file.current_version_id))) throw new Error('Primary goal is not a supported accessible Goal File');
  const storage = file.object?.storage_object;
  const digest = String(storage?.sha256_hex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(storage?.size_bytes) || storage.size_bytes < 1 || storage.size_bytes > MAX_BYTES) throw new Error('Primary goal version integrity metadata is unavailable');
  let bytes;
  try { bytes = await client.readVersionBytes(file.id, file.current_version_id, { maxBytes: MAX_BYTES }); }
  catch (error) { if (error.status === 403) return reference; throw error; }
  if (bytes.byteLength > MAX_BYTES || bytes.byteLength !== storage.size_bytes || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Primary goal version integrity check failed');
  let goal;
  try { goal = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('Primary goal content is invalid'); }
  if (!validGoal(goal)) throw new Error('Primary goal content is unsupported or invalid');
  return reference;
}

export function outputGoalMetadata(metadata = {}, reference) {
  const canonical = reference ? primaryGoalReference(reference) : null;
  if (!object(metadata)) throw new Error('File metadata must be an object');
  if (metadata.ambulando_goal !== undefined) {
    const supplied = primaryGoalReference(metadata.ambulando_goal);
    if (!canonical || supplied.goal_file_id !== canonical.goal_file_id) throw new Error('Output goal metadata disagrees with the authoritative chat');
    return { ...metadata, ambulando_goal: canonical };
  }
  return canonical ? { ...metadata, ambulando_goal: canonical } : metadata;
}
