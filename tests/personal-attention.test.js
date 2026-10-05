import { describe, expect, it } from 'vitest';
import { hasPersonalUnreadAttention, personalAttentionVersion, mentionsViewer } from '../src/personal-attention.js';
import { mapPgTaskToLocal, mapPgDocToLocal } from '../src/pg-read-hydrator.js';
import { buildAutopilotOverviewFiles } from '../src/autopilot-overview-manager.js';
import { unreadStoreMixin } from '../src/unread-store.js';

const actor = 'viewer';
const options = { viewerActorId: actor, viewerNpub: 'npub1viewer' };
const mention = { type: 'person', actor_id: actor, npub: 'npub1viewer' };
const attention = (versions = {}, body = 0) => ({ policy_version: 1, mention_activity_versions: versions, body_activity_version: body, last_activity_actor_id: 'author', body_actor_id: 'author' });
const state = (viewed = 0, type = 'task') => ({ resource_type: type, resource_id: 'item', viewer_actor_id: actor, viewed_activity_version: viewed });
const task = (version, assigned = false, mentions = {}) => ({ record_id: 'item', activity_version: version, assigned_to_npubs: assigned ? ['npub1viewer'] : [], pg_attention: attention(mentions) });
const doc = (version, body, mentions = [mention], comments = {}) => ({ record_id: 'item', pg_record_type: 'doc', activity_version: version, pg_metadata: { mentions }, pg_attention: attention(comments, body) });

describe('personal attention policy', () => {
  it('keeps chat unread until the existing view position catches up', () => {
    expect(hasPersonalUnreadAttention({ activity_version: 3 }, state(2, 'thread'), options)).toBe(true);
    expect(hasPersonalUnreadAttention({ activity_version: 3 }, state(3, 'thread'), options)).toBe(false);
  });
  it('keeps unrelated task activity neutral, rearms on assignment, then clears on another device read', () => {
    expect(hasPersonalUnreadAttention(task(5), state(4), options)).toBe(false);
    expect(hasPersonalUnreadAttention(task(6, true), state(5), options)).toBe(true);
    expect(hasPersonalUnreadAttention(task(6, true), state(6), options)).toBe(false);
    expect(hasPersonalUnreadAttention(task(7, true), state(6), options)).toBe(true);
  });
  it('uses the explicit primary and explicit clear over stale former-assignee relations', () => {
    const stale = { ...task(8), assigned_to_npub: 'npub1other', assignments: [{actor_id:actor,actor_npub:'npub1viewer'}] };
    expect(hasPersonalUnreadAttention(stale,state(4),options)).toBe(false);
    expect(hasPersonalUnreadAttention({...stale,assigned_to_npub:null},state(4),options)).toBe(false);
    expect(hasPersonalUnreadAttention({...stale,pg_attention:{...stale.pg_attention,mention_activity_versions:{[actor]:7}}},state(4),options)).toBe(true);
  });
  it('does not resurrect read comment mentions on unassignment or unrelated comments', () => {
    expect(hasPersonalUnreadAttention(task(8, false, { viewer: 4 }), state(4), options)).toBe(false);
    expect(hasPersonalUnreadAttention(task(9, false, { viewer: 9 }), state(4), options)).toBe(true);
    expect(hasPersonalUnreadAttention(task(10, false, { viewer: 9 }), state(9), options)).toBe(false);
  });
  it('uses canonical actor IDs before potentially stale visible npubs', () => {
    expect(mentionsViewer([{ ...mention, actor_id: 'someone-else' }], { actorId: actor, npub: mention.npub })).toBe(false);
    expect(mentionsViewer([{ type: 'person', npub: mention.npub }], { actorId: actor, npub: mention.npub })).toBe(true);
    expect(mentionsViewer([{ type: 'document', actor_id: actor }], options)).toBe(false);
    expect(personalAttentionVersion({ ...doc(5, 5, []), content: '@[Reader](mention:person:npub1viewer)' }, state(0, 'document'), options)).toBe(0);
  });
  it('separates document body mentions from unrelated comments, body edits and removed body mentions', () => {
    expect(hasPersonalUnreadAttention(doc(5, 4), state(4, 'document'), options)).toBe(false);
    expect(hasPersonalUnreadAttention(doc(6, 6), state(4, 'document'), options)).toBe(true);
    expect(hasPersonalUnreadAttention(doc(7, 6, []), state(4, 'document'), options)).toBe(false);
    expect(hasPersonalUnreadAttention(doc(8, 6, [], { viewer: 8 }), state(7, 'document'), options)).toBe(true);
    expect(hasPersonalUnreadAttention(doc(9, 6, [], { viewer: 8 }), state(8, 'document'), options)).toBe(false);
  });
  it('excludes own-authored body and assigned activity', () => {
    expect(hasPersonalUnreadAttention({ ...task(5, true), pg_attention: { ...attention(), last_activity_actor_id: actor } }, state(), options)).toBe(false);
    expect(hasPersonalUnreadAttention({ ...doc(5, 5), pg_attention: { ...attention({}, 5), body_actor_id: actor } }, state(0, 'document'), options)).toBe(false);
  });
  it('prefers current canonical removal over a stale personalized state at the same activity version', () => {
    const stale = { ...state(4), activity_version: 9, attention_policy_version: 1, attention_activity_version: 9 };
    expect(hasPersonalUnreadAttention(task(9, false, {}), stale, options)).toBe(false);
    expect(hasPersonalUnreadAttention(task(9, false, { viewer: 9 }), stale, options)).toBe(true);
  });
  it('resolves persisted assignment actors through the canonical translator', () => {
    const row = mapPgTaskToLocal({ id: 'item', activity_version: 6, attention: attention(),
      assignments: [{ actor_id: actor, deleted_at: null }] }, { actorNpubByActorId: new Map([[actor, 'npub1viewer']]) });
    expect(hasPersonalUnreadAttention(row, state(5), options)).toBe(true);
    const removed = mapPgTaskToLocal({ id: 'item', activity_version: 6, attention: attention(),
      assignments: [{ actor_id: actor, deleted_at: '2026-10-05T00:00:00Z' }] }, { actorNpubByActorId: new Map([[actor, 'npub1viewer']]) });
    expect(hasPersonalUnreadAttention(removed, state(5), options)).toBe(false);
  });
  it('preserves attention positions through canonical translators', () => {
    const canonical = { id: 'item', attention: attention({ viewer: 5 }, 4), activity_version: 6 };
    expect(mapPgTaskToLocal(canonical).pg_attention).toEqual(canonical.attention);
    expect(mapPgDocToLocal(canonical).pg_attention).toEqual(canonical.attention);
  });
  it('keeps standalone files neutral and hides parent attachments without deleting their source rows', () => {
    const rows = [
      { object_id: 'standalone', pg_record_type: 'file', isUnread: true },
      { object_id: 'thread', pg_record_type: 'file', thread_id: 'thread' },
      { object_id: 'thread', pg_record_type: 'file' },
      { object_id: 'task', source_type: 'task' },
      { object_id: 'comment', source_type: 'comment', source_target_type: 'task' },
    ];
    expect([...buildAutopilotOverviewFiles(rows)]).toMatchObject([{ object_id: 'standalone', isUnread: false }]);
    expect(rows).toHaveLength(5);
    expect(personalAttentionVersion({ pg_record_type: 'file', activity_version: 50 }, state(0, 'document'), options)).toBe(0);
  });
  it('uses one map for item, channel, section and Deck aggregates even with neutral activity present', () => {
    const store = { ...options, currentPgActorId: actor, currentViewerNpub: 'npub1viewer', tasks: [task(6, false, { viewer: 5 })], documents: [doc(8, 4)] };
    unreadStoreMixin.applyTowerPgResourceViewStates.call(store, [
      { ...state(4), activity_version: 6, channel_id: 'tasks' },
      { ...state(4, 'document'), activity_version: 8, channel_id: 'docs' },
    ]);
    expect(store._unreadTaskItems).toEqual({ item: true });
    expect(store._unreadDocItems).toEqual({});
    expect(store._unreadChannels).toEqual({ tasks: true });
    expect(store._unreadTasks).toBe(true);
    expect(store._unreadDocs).toBe(false);
    expect(Object.getOwnPropertyDescriptor(unreadStoreMixin, 'unreadDeck').get.call(store)).toBe(true);
  });
  it('accepts additive view-state attention without requiring parent hydration and retains old Tower compatibility', () => {
    expect(hasPersonalUnreadAttention({}, { ...state(4), activity_version: 10, attention_policy_version: 1, attention_activity_version: 4 }, options)).toBe(false);
    expect(hasPersonalUnreadAttention({}, { ...state(4), activity_version: 10, attention_policy_version: 1, attention_activity_version: 9 }, options)).toBe(true);
    const historical = { ...task(8), pg_attention: null };
    const comments = [{ metadata: { mentions: [mention] }, created_by_actor_id: 'author', updated_at: '2026-10-05T02:00:00Z' }];
    expect(hasPersonalUnreadAttention(historical, { ...state(4), updated_at: '2026-10-05T03:00:00Z' }, { ...options, comments })).toBe(false);
    expect(hasPersonalUnreadAttention(historical, { ...state(4), updated_at: '2026-10-05T01:00:00Z' }, { ...options, comments })).toBe(true);
  });
});
