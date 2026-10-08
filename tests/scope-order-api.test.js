import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: vi.fn(async () => 'actor-auth'), owner: vi.fn(async () => 'owner-auth') }));
vi.mock('../src/auth/nostr.js', () => ({ createNip98AuthHeader: mocks.actor, createNip98AuthHeaderForSecret: mocks.owner }));
vi.mock('../src/crypto/workspace-keys.js', () => ({ getActiveWorkspaceKeySecretForAuth: () => new Uint8Array(32).fill(1), getActiveWorkspaceKeyNpub: () => 'workspace-owner' }));
vi.mock('../src/crypto/group-keys.js', () => ({ getActiveSessionNpub: () => 'reader' }));
import { getTowerPgScopeOrder, putTowerPgScopeOrder, setBaseUrl } from '../src/api.js';
beforeEach(() => { vi.clearAllMocks();setBaseUrl('http://127.0.0.1:3100');vi.stubGlobal('fetch',vi.fn(async()=>Response.json({scope_order:{scope_ids:[]}}))); });
it('uses actual reader authentication for both preference reads and writes even with an active owner key',async()=>{
 await getTowerPgScopeOrder('workspace');await putTowerPgScopeOrder('workspace',{scope_ids:[],expected_row_version:0,mutation_id:'mutation'});
 expect(mocks.actor).toHaveBeenCalledTimes(2);expect(mocks.owner).not.toHaveBeenCalled();
 expect(fetch.mock.calls.every(([url,options])=>url.endsWith('/me/scope-order')&&options.headers.Authorization==='actor-auth')).toBe(true);
});
