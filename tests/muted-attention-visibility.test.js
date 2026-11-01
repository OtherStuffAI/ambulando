import { expect, it } from 'vitest';
import { directMentionAttentionVersion } from '../src/personal-attention.js';

it('cannot restore archived, deleted or file attention through the muted mention projection', () => {
  const row={activity_version:10,attention:{policy_version:1,mention_activity_versions:{viewer:8}}};
  const state={resource_type:'thread',viewed_activity_version:2};
  const options={viewerActorId:'viewer'};
  expect(directMentionAttentionVersion(row,state,options)).toBe(8);
  for(const hidden of [{archived_at:'2026-11-01'},{deleted_at:'2026-11-01'},{record_state:'archived'}, {record_state:'deleted'},{pg_record_type:'file'}]) {
    expect(directMentionAttentionVersion({...row,...hidden},state,options)).toBe(0);
  }
});

it('cannot promote a retained hidden projection with a stale mention position', async () => {
  const {openWorkspaceDb,deleteWorkspaceDb}=await import('../src/db.js');
  const {getPgAttentionProjection,recordDeltaCursorKey}=await import('../src/pg-record-delta.js');
  const {notificationInboxContext}=await import('../src/notification-inbox-store.js');
  const db=openWorkspaceDb('muted-hidden-attention');await db.open();
  try {
    const store={session:{npub:'reader'},currentWorkspace:{workspaceId:'workspace',directHttpsUrl:'http://localhost:3100',pgMe:{actor:{actor_id:'viewer',npub:'reader'}}},
      messages:[{record_id:'thread'}]};
    await db.sync_state.put({key:recordDeltaCursorKey(store),value:{cursor:'kept'}});
    await db.notification_inbox.put({key:notificationInboxContext(store).key,channel_preferences:[{channel_id:'muted',mode:'mentions_only'}]});
    await db.pg_resource_attention.put({record_id:'thread:thread',resource_type:'thread',resource_id:'thread',channel_id:'muted',unread:0,
      mention_activity_version:8,viewed_activity_version:2});
    const projection=await getPgAttentionProjection(store);
    expect(projection.visible[0].unread).toBe(0);
    expect(projection.values['channel:muted']).toBe(0);
    expect((await db.pg_resource_attention.get('thread:thread')).mention_activity_version).toBe(8);
  } finally {await deleteWorkspaceDb('muted-hidden-attention');}
});
