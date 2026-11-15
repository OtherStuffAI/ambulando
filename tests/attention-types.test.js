import { expect, it } from 'vitest';
import { ATTENTION_TYPES, attentionTypeEnabled, toggleAttentionType, filterDeckAttention, notificationAttentionType } from '../src/attention-types.js';
it('supports every combination without mutating Deck records or hiding neutral activity', () => {
 const rows=ATTENTION_TYPES.flatMap(inboxKind=>[{inboxKind,isUnread:true},{inboxKind,isUnread:false}]);
 for(let mask=0;mask<32;mask++) {
  const disabled=ATTENTION_TYPES.filter((_,i)=>mask&(1<<i));const value=JSON.stringify({version:1,disabled});
  expect(filterDeckAttention(rows,value)).toHaveLength(10-disabled.length);
  for(const type of ATTENTION_TYPES) expect(attentionTypeEnabled(value,type)).toBe(!disabled.includes(type));
 }
 expect(rows.every(row=>typeof row.isUnread==='boolean')).toBe(true);
 expect(filterDeckAttention([{inboxKind:'future',isUnread:true}],'{"version":1,"disabled":["future"]}')).toHaveLength(1);
});
it('defaults missing, invalid and future schemas to visible and preserves extensions on toggles', () => {
 for(const value of ['',null,'bad','{}','{"version":"1","disabled":["chat"]}','{"version":2,"disabled":["chat"]}','{"version":1,"disabled":[null]}']) expect(attentionTypeEnabled(value,'chat')).toBe(true);
 const original='{"version":1,"disabled":["future","task"],"extension":{"keep":true}}';
 expect(JSON.parse(toggleAttentionType(original,'task',true))).toEqual({version:1,disabled:['future'],extension:{keep:true}});
 expect(()=>toggleAttentionType('{"version":2,"disabled":[]}','chat',false)).toThrow('unsupported');
 expect(notificationAttentionType({target:{kind:'task_comment'}})).toBe('task');
 expect(notificationAttentionType({target:{kind:'unknown'}})).toBe('other');
});
it('hides relevant navigation badges without rewriting the attention maps', async () => {
 const {unreadStoreMixin}=await import('../src/unread-store.js');
 const store=Object.defineProperties({},Object.getOwnPropertyDescriptors(unreadStoreMixin));
 store._unreadChat=true;store._unreadTasks=true;store._unreadDocs=true;store._unreadChannels={channel:true};
 store.isAttentionTypeEnabled=()=>false;
 expect([store.unreadChat,store.unreadTasks,store.unreadDocs,store.unreadDeck,store.isChannelUnread('channel')]).toEqual([false,false,false,false,false]);
 expect(store._unreadChannels).toEqual({channel:true});expect(store._unreadTasks).toBe(true);
 store.isAttentionTypeEnabled=()=>true;expect(store.unreadDeck).toBe(true);expect(store.isChannelUnread('channel')).toBe(true);
});
