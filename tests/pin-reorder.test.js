import {expect,it,vi} from 'vitest';
import {pinReorderMixin} from '../src/pin-reorder.js';
function store(){return {...pinReorderMixin,pinnedThreadsPartition:'workspace',pinnedThreads:[{key:'channel:same',title:'Channel'},{key:'thread:same',title:'Thread'},{key:'task:other',title:'Task'}],savePersonalPinMove:vi.fn()};}
const event=key=>({key,preventDefault:vi.fn(),stopPropagation:vi.fn()});
it('keyboard moves use typed keys, announce insertion and commit only one item',async()=>{
 const s=store(),pin=s.pinnedThreads[0];s.pinMoveKeydown(event(' '),pin);s.pinMoveKeydown(event('End'),pin);
 expect(s.pinMove.keys).toEqual(['thread:same','task:other','channel:same']);expect(s.pinInsertionClass(s.pinnedThreads[2])).toMatchObject({'pin-insert-after':true});expect(s.pinMoveAnnouncement).toContain('position 3 of 3');
 await s.finishPinMove();expect(s.savePersonalPinMove).toHaveBeenCalledWith('channel:same',null,'task:other');expect(s.pinMove).toBeNull();
});
it('cancel, workspace switches and concurrent unpins do not save; new pins are not replaced',async()=>{
 const s=store(),pin=s.pinnedThreads[0];s.startPinMove(pin);s.pinMoveKeydown(event('Escape'),pin);expect(s.savePersonalPinMove).not.toHaveBeenCalled();
 s.startPinMove(pin);s.pinnedThreadsPartition='other';await s.finishPinMove();expect(s.savePersonalPinMove).not.toHaveBeenCalled();
 s.startPinMove(pin);s.pinnedThreads.shift();await s.finishPinMove();expect(s.savePersonalPinMove).not.toHaveBeenCalled();expect(s.pinMoveAnnouncement).toContain('unpinned');
});
