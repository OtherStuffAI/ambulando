import { expect, it, vi } from 'vitest';
import { createShellState } from '../src/shell-state.js';
it('reveals New and Summary only for an explicit Task Tree board navigation',async()=>{
  const old=globalThis.window;
  globalThis.window={location:{href:'http://localhost/tasks?scopeid=__pg_channel__:channel&revealnew=1'},history:{state:null}};
  try {
    const shell=createShellState();
    Object.assign(shell,{knownWorkspaces:[],collapsedSections:{new:true,summary:true,done:true},taskFilter:'old',taskFilterState:'done',taskFilterTags:['old'],taskFilterAssignee:'old',
      validateSelectedBoardId:vi.fn(),persistSelectedBoardId:vi.fn(),normalizeTaskFilterTags:vi.fn(),closeTaskDetail:vi.fn(),startWorkspaceLiveQueries:vi.fn(),syncRoute:vi.fn()});
    await shell.applyRouteFromLocation();
    expect(shell.selectedBoardId).toBe('__pg_channel__:channel');
    expect(shell.collapsedSections).toEqual({new:false,summary:false,done:true});
    expect([shell.taskFilter,shell.taskFilterState,shell.taskFilterAssignee]).toEqual(['','','']);
    expect(shell.taskFilterTags).toEqual([]);
    shell.collapsedSections.new=true;window.location.href='http://localhost/tasks?scopeid=other';
    await shell.applyRouteFromLocation();expect(shell.collapsedSections.new).toBe(true);
  }finally{globalThis.window=old;}
});

it('loads cold channel navigation through the sync owner before validating the requested board',async()=>{
  const old=globalThis.window;globalThis.window={location:{href:'http://localhost/tasks?scopeid=__pg_channel__:channel&revealnew=1'},history:{state:null}};
  try {
    const shell=createShellState();const calls=[];
    Object.assign(shell,{currentWorkspace:{pgBackendMode:true},currentWorkspaceKey:'workspace',knownWorkspaces:[],channels:[],collapsedSections:{new:true},
      requestTowerSyncFamily:vi.fn(async()=>{calls.push('sync');}),loadLocalChannels:vi.fn(async()=>{calls.push('dexie');shell.channels=[{record_id:'channel'}];}),
      validateSelectedBoardId:vi.fn(()=>{calls.push('validate');expect(shell.channels[0].record_id).toBe('channel');}),persistSelectedBoardId:vi.fn(),normalizeTaskFilterTags:vi.fn(),closeTaskDetail:vi.fn(),startWorkspaceLiveQueries:vi.fn(),syncRoute:vi.fn()});
    await shell.applyRouteFromLocation();
    expect(calls).toEqual(['sync','dexie','validate']);
    expect(shell.requestTowerSyncFamily).toHaveBeenCalledWith('channel','channel',{force:true});
    expect(shell.selectedBoardId).toBe('__pg_channel__:channel');
  }finally{globalThis.window=old;}
});
