import { beforeEach, expect, it, vi } from 'vitest';
import { getSettings, getSharedDb, openWorkspaceDb, saveSettings, saveThreadPin, getPinnedThreadRows, upsertMessage } from '../src/db.js';
import { autopilotOverviewManagerMixin } from '../src/autopilot-overview-manager.js';
import { pinnedThreadsMixin } from '../src/pinned-threads.js';
let db;
function store() {
  const s = { currentWorkspaceKey:'tower/workspace', session:{npub:'alice'}, currentViewerNpub:'alice',
    isTowerPgMode:true, openAutopilotOverviewThread:vi.fn() };
  Object.defineProperties(s, Object.getOwnPropertyDescriptors(pinnedThreadsMixin));
  return s;
}
const pin = {id:'thread',rootRecordId:'source',channelId:'channel'};
beforeEach(async () => {
  db = openWorkspaceDb('pinned-test'); await db.open();
  await Promise.all(db.tables.map(t => t.clear()));
  await getSharedDb().app_settings.clear();
  await db.channels.put({record_id:'channel',scope_id:'other-scope',record_state:'active'});
  await upsertMessage({record_id:'thread', pg_record_type:'thread',pg_source_message_id:'source',channel_id:'channel',title:'Current title',record_state:'active',updated_at:'2026-10-01T00:00:00Z'});
  await upsertMessage({record_id:'source',pg_thread_id:'thread',channel_id:'channel',body:'Old title',record_state:'active',updated_at:'2026-10-01T00:00:00Z'});
  await upsertMessage({record_id:'reply',pg_thread_id:'thread',parent_message_id:'source',channel_id:'channel',body:'Reply',record_state:'active',updated_at:'2026-10-02T00:00:00Z'});
});
it('atomically persists pins without changing records, receipts, pending writes or other preferences', async () => {
  await saveSettings({theme:'dark'});
  await db.resource_view_states.put({record_id:'thread:thread',resource_type:'thread',resource_id:'thread',viewed_activity_version:2});
  await db.pg_resource_attention.put({record_id:'thread:thread',unread:1});
  const receipts=await db.resource_view_states.toArray();
  const attention=await db.pg_resource_attention.toArray();
  const before = await db.chat_messages.toArray();
  await Promise.all([saveThreadPin('alice',pin,true),saveThreadPin('bob',{...pin,id:'other'},true)]);
  expect((await getSettings()).theme).toBe('dark');
  expect(Object.keys((await getSettings()).threadPins.alice)).toEqual(['thread']);
  expect(Object.keys((await getSettings()).threadPins.bob)).toEqual(['other']);
  expect(await db.chat_messages.toArray()).toEqual(before);
  expect(await db.resource_view_states.toArray()).toEqual(receipts);
  expect(await db.pg_resource_attention.toArray()).toEqual(attention);
  expect(await db.pending_writes.count()).toBe(0);
  await saveThreadPin('alice',pin,false);
  expect((await getSettings()).threadPins.alice).toEqual({});
});
it('reads canonical titles and latest replies outside the selected scope or bounded Inbox', async () => {
  await db.pg_resource_attention.put({record_id:'thread:thread',unread:1});
  const [row] = await getPinnedThreadRows(db,{thread:{...pin,pinnedAt:'2026-10-03'}});
  expect(row).toMatchObject({title:'Current title',activityAt:'2026-10-02T00:00:00Z',persistedUnread:true,rootRecordId:'source',unavailable:false});
  await db.chat_messages.update('thread',{title:'Renamed',updated_at:'2026-10-04T00:00:00Z'});
  expect((await getPinnedThreadRows(db,{thread:pin}))[0]).toMatchObject({title:'Renamed',activityAt:'2026-10-04T00:00:00Z'});
});
it('keeps unavailable pins removable without leaking cached titles', async () => {
  for (const change of [{record_state:'deleted'},{record_state:'archived'},{record_state:'active',can_read:false}]) {
    await db.channels.update('channel',change);
    expect((await getPinnedThreadRows(db,{thread:pin}))[0]).toMatchObject({title:'Thread unavailable',unavailable:true});
  }
  expect((await getPinnedThreadRows(db,{missing:{...pin,id:'missing',rootRecordId:'missing'}}))[0].unavailable).toBe(true);
});
it('liveQuery follows reload, title/read changes and reader/workspace boundaries', async () => {
  const s=store(); s.syncPinnedThreadsContext(s.pinnedThreadsPartition);
  await s.toggleThreadPin(pin);
  await vi.waitFor(() => expect(s.pinnedThreads).toHaveLength(1));
  const restored=store(); restored.syncPinnedThreadsContext(restored.pinnedThreadsPartition);
  await vi.waitFor(() => expect(restored.pinnedThreads).toHaveLength(1));
  await db.pg_resource_attention.put({record_id:'thread:thread',unread:1});
  await vi.waitFor(() => expect(restored.pinnedThreads[0].isUnread).toBe(true));
  await db.pg_resource_attention.update('thread:thread',{unread:0});
  await vi.waitFor(() => expect(restored.pinnedThreads[0].isUnread).toBe(false));
  restored.selectedBoardScope='unrelated'; expect(restored.pinnedThreads).toHaveLength(1);
  restored.openPinnedThread(restored.pinnedThreads[0]); expect(restored.openAutopilotOverviewThread).toHaveBeenCalledWith(expect.objectContaining({channelId:'channel',rootRecordId:'source'}));
  restored.currentViewerNpub='bob'; expect(restored.pinnedThreads).toEqual([]);
  restored.syncPinnedThreadsContext(restored.pinnedThreadsPartition);
  restored.currentWorkspaceKey='another'; expect(restored.pinnedThreads).toEqual([]);
  s.session=null; s.syncPinnedThreadsContext(''); restored.session=null; restored.syncPinnedThreadsContext('');
});
it('orders by pin time rather than activity and reports save failures without optimistic loss', async () => {
  const s=store(); s.pinnedThreadsContext=s.pinnedThreadsPartition;
  s.pinnedThreadRows=[{...pin,pinnedAt:'2026-10-01',activityAt:'2026-10-10'}, {...pin,id:'second',pinnedAt:'2026-10-02',activityAt:'2026-10-02'}];
  expect(s.pinnedThreads.map(r=>r.id)).toEqual(['second','thread']);
  const fail=vi.spyOn(getSharedDb().app_settings,'add').mockRejectedValueOnce(new Error('Storage failed'));
  await s.toggleThreadPin(pin); expect(s.pinnedThreadsError).toBe('Storage failed'); expect(s.isThreadPinned('thread')).toBe(true); fail.mockRestore();
});

it('only includes the mobile pin page while pins exist and returns to Inbox after last unpin', () => {
  const s=store(); const cards=Object.getOwnPropertyDescriptor(autopilotOverviewManagerMixin,'deckMobileCards').get;
  expect(cards.call(s).map(row=>row.id)).not.toContain('pinned');
  s.pinnedThreadsContext=s.pinnedThreadsPartition;
  s.pinnedThreadRows=[{...pin,pinnedAt:'2026-10-01'}];
  expect(cards.call(s).map(row=>row.id)).toContain('pinned');
  s.pinnedThreadRows=[]; s.deckMobileColumn='pinned'; s.deckMobileTrack={}; s.deckMobileMediaQuery={matches:true}; s.positionDeckMobileCard=vi.fn();
  vi.stubGlobal('requestAnimationFrame',callback=>callback());
  s.syncPinnedThreadsLayout();
  expect(s.deckMobileColumn).toBe('inbox'); expect(s.positionDeckMobileCard).toHaveBeenCalledWith('inbox');
  vi.unstubAllGlobals();
});

it('opens task/document pins through the established internal record navigation without changing read or edit state on pin',async()=>{
 const s=store();s.handleMentionNavigate=vi.fn().mockResolvedValue(true);s.pinnedThreadsContext=s.pinnedThreadsPartition;
 s.pinnedThreadRows=[{id:'task',type:'task',pinnedAt:'2026-10-01',unavailable:false},{id:'doc',type:'document',pinnedAt:'2026-10-02',unavailable:false}];
 await s.openPinnedThread(s.pinnedThreads[0]);await s.openPinnedThread(s.pinnedThreads[1]);
 expect(s.handleMentionNavigate).toHaveBeenCalledWith('doc','doc');expect(s.handleMentionNavigate).toHaveBeenCalledWith('task','task');
 s.pinnedThreadRows[0].unavailable=true;expect(await s.openPinnedThread(s.pinnedThreadRows[0])).toBe(false);
 expect(s.isThreadPinned('task')).toBe(false);expect(s.isPersonalPinned('task','task')).toBe(true);
});

it('keeps the canonical thread identity when an Inbox navigation row also carries a source record id',async()=>{
 const s=store();await s.toggleThreadPin({...pin,recordId:'source'});
 expect(Object.keys((await getSettings()).threadPins[s.pinnedThreadsPartition])).toEqual(['thread']);
});
