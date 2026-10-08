import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeDiagnostics, createDiagnosticOperation } from '../src/diagnostics-events.js';
import { sanitizeDiagnosticEvent } from '../src/diagnostics-schema.js';

vi.mock('../src/auth/nostr.js', () => ({
  createNip98AuthHeader: vi.fn(async (requestUrl, method) => `NIP98 ${method} ${requestUrl}`),
  createNip98AuthHeaderForSecret: vi.fn(async (requestUrl, method) => `NIP98-SECRET ${method} ${requestUrl}`),
}));

vi.mock('../src/crypto/workspace-keys.js', () => ({
  getActiveWorkspaceKeySecretForAuth: vi.fn(() => null),
  getActiveWorkspaceKeyNpub: vi.fn(() => 'npub1workspacekey'),
}));

vi.mock('../src/crypto/group-keys.js', () => ({
  getActiveSessionNpub: vi.fn(() => 'npub1session'),
}));

describe('Tower PG API helpers', () => {
  const originalFetch = globalThis.fetch;

  it('retains owned conflict attempts but promotes independent HTTP and transport failures', async () => {
    const api=await import('../src/api.js');
    const events=[];
    const stop=observeDiagnostics(input=>events.push(sanitizeDiagnosticEvent({...input,ts:Date.now()})));
    const diagnosticOperation=createDiagnosticOperation('thread-rename');
    globalThis.fetch.mockResolvedValueOnce({ok:false,status:409,text:async()=>JSON.stringify({code:'stale_row_version'})});
    await expect(api.updateTowerPgThread('SECRET','SECRET',{title:'SECRET'},{baseUrl:'https://tower.example',diagnosticOperation})).rejects.toMatchObject({status:409});
    expect(events.at(-1)).toMatchObject({outcome:'attempt',level:'info',route:'/api/v4/flightdeck-pg/workspaces/:id/threads/:id',status:409});
    for(const status of [401,404,409]) {
      globalThis.fetch.mockResolvedValueOnce({ok:false,status,text:async()=>''});
      await expect(api.getTowerPgRecordSync('SECRET',{baseUrl:'https://tower.example',cursor:'SECRET'})).rejects.toMatchObject({status});
      expect(events.at(-1)).toMatchObject({outcome:'failed',level:'error',status});
    }
    globalThis.fetch.mockRejectedValueOnce(new TypeError('SECRET'));
    await expect(api.getTowerPgRecordSync('SECRET',{baseUrl:'https://tower.example'})).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({outcome:'failed',level:'error',status:0,category:'transport'});
    expect(JSON.stringify(events)).not.toContain('SECRET');
    stop();
  });

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (requestUrl) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, requestUrl }),
      text: async () => JSON.stringify({ ok: true, requestUrl }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('signs the exact context unlink URL and DELETE JSON version payload', async () => {
    const { createNip98AuthHeader } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    const body = { expected_row_version: 3 };
    await api.requestTowerPgContext('workspace', 'scope', '/component/references/reference', {
      method: 'DELETE', body, baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg',
    });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://tower.example/api/v4/flightdeck-pg/workspaces/workspace/scopes/scope/context/components/component/references/reference');
    expect(options.method).toBe('DELETE'); expect(JSON.parse(options.body)).toEqual(body);
    expect(createNip98AuthHeader).toHaveBeenLastCalledWith(url, 'DELETE', body, expect.objectContaining({ priority: 'high' }));
  });

  it('signs the selected workspace usage URL and preserves status and cancellation', async () => {
    const api = await import('../src/api.js');
    const controller = new AbortController();
    await api.getTowerPgStorageUsage('workspace/a', { baseUrl: 'https://selected.example', appNpub: 'selected-app', signal: controller.signal });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://selected.example/api/v4/flightdeck-pg/workspaces/workspace%2Fa/storage-usage');
    expect(options.headers['x-flightdeck-pg-app-npub']).toBe('selected-app');
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => '{}' });
    await expect(api.getTowerPgStorageUsage('workspace', { baseUrl: 'https://selected.example' })).rejects.toMatchObject({ status: 403 });
    controller.abort();
    await expect(api.getTowerPgStorageUsage('workspace', { baseUrl: 'https://selected.example', signal: controller.signal })).rejects.toThrow();
  });

  it('calls Tower PG descriptor and me routes with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkspaceDescriptor('workspace-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkspaceMe('workspace-1', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/me',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(2);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('signs exact bounded activity history cursors without rounding bigint delivery positions', async () => {
    const api = await import('../src/api.js');
    await api.getTowerPgAgentActivities('workspace-1', {
      channelId: 'channel-1', activityId: 'activity-1', afterCommentaryCursor: '9007199254740993',
      historyLimit: 200, baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg',
    });
    const [requestUrl, options] = globalThis.fetch.mock.calls[0];
    const params = new URL(requestUrl).searchParams;
    expect(params.get('after_commentary_cursor')).toBe('9007199254740993');
    expect(params.get('history_limit')).toBe('200');
    expect(params.get('activity_id')).toBe('activity-1');
    expect(params.has('after_sequence')).toBe(false);
    expect(options.headers.Authorization).toBe(`NIP98 GET ${requestUrl}`);
  });

  it('fetches session health with exact channel, thread and session filters', async () => {
    const api = await import('../src/api.js');
    await api.getTowerPgAgentSessionHealth('workspace-1', {
      channelId: 'channel-1', threadId: 'thread-1', sessionId: 'session-1',
      baseUrl: 'https://tower.example', appNpub: 'flightdeck_pg',
    });
    const [requestUrl, options] = globalThis.fetch.mock.calls[0];
    const parsed = new URL(requestUrl);
    expect(parsed.pathname).toBe('/api/v4/flightdeck-pg/workspaces/workspace-1/agent-session-health');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      channel_id: 'channel-1', thread_id: 'thread-1', session_id: 'session-1', limit: '100',
    });
    expect(options.headers.Authorization).toBe(`NIP98 GET ${requestUrl}`);
  });

  it('upgrades an advertised http descriptor link to its configured https Tower', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkspaceDescriptor('workspace-1', {
      appNpub: 'flightdeck_pg',
      baseUrl: 'https://tower.example',
      path: 'http://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fetches a workspace sync delta with one signed request', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkspaceSync('workspace-1', {
      appNpub: 'flightdeck_pg',
      cursor: 'cursor-7',
      limit: 500,
    });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/sync?cursor=cursor-7&limit=500',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/sync?cursor=cursor-7&limit=500',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
  });

  it('signs and fetches the identical final URL with encoding and repeated parameters', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const finalUrl = 'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes?search=two%20words&tag=one&tag=two&limit=25';

    await api.getTowerPgWorkspaceScopes('workspace-1', {
      appNpub: 'flightdeck_pg',
      path: '/api/v4/flightdeck-pg/workspaces/workspace-1/scopes?search=two%20words&tag=one&tag=two',
      limit: 25,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      finalUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `NIP98 GET ${finalUrl}` }),
      }),
    );
  });

  it('aborts a stalled workspace sync request at the caller timeout', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    globalThis.fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
    }));

    await expect(api.getTowerPgWorkspaceSync('workspace-1', {
      appNpub: 'flightdeck_pg',
      timeoutMs: 5,
    })).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/sync?limit=500',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('updates a canonical workspace member display name through the typed profile route', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.updateTowerPgWorkspaceMemberProfile(
      'workspace-1',
      'actor-testagent',
      { display_name: 'Test Agent' },
      { appNpub: 'flightdeck_pg' },
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/members/actor-testagent/profile',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/members/actor-testagent/profile',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({ display_name: 'Test Agent' }),
      }),
    );
  });

  it('updates Tower PG file metadata with PATCH auth', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.updateTowerPgFile('workspace-1', 'file-1', {
      row_version: 3,
      channel_id: 'channel-2',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/files/file-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/files/file-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          row_version: 3,
          channel_id: 'channel-2',
        }),
      }),
    );
  });

  it('lists Tower PG workspaces with real-user auth when a workspace key is active', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    getActiveWorkspaceKeySecretForAuth.mockReturnValueOnce(new Uint8Array([7]));

    const result = await api.listTowerPgWorkspaces({ appNpub: 'flightdeck_pg', limit: 25 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=flightdeck_pg&limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=flightdeck_pg&limit=25',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=flightdeck_pg&limit=25',
      'GET',
      null,
      {
        signTimeoutMs: 10000,
        timeoutMessage: 'NIP-98 signing timed out for GET https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=flightdeck_pg&limit=25',
        priority: 'normal',
      },
    );
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
    expect(result.towerPgRequest).toMatchObject({
      method: 'GET',
      url: 'https://tower.example/api/v4/flightdeck-pg/workspaces?app_npub=flightdeck_pg&limit=25',
      route: '/api/v4/flightdeck-pg/workspaces',
      query: 'app_npub=flightdeck_pg&limit=25',
      body: null,
      appNpub: 'flightdeck_pg',
      appNpubSent: true,
      signerNpub: 'npub1session',
      usedWorkspaceKey: false,
      transportMode: 'https',
      httpStatus: 200,
      responseShape: {
        type: 'object',
        keys: ['ok', 'requestUrl'],
      },
    });
  });

  it('uses real-user auth for Tower PG connection service and verification routes', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    getActiveWorkspaceKeySecretForAuth.mockReturnValue(new Uint8Array([7]));

    await api.getTowerPgService({ appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkspaceDescriptor('workspace-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkspaceMe('workspace-1', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(createNip98AuthHeader).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/service',
      'GET',
      null,
      expect.objectContaining({ priority: 'normal' }),
    );
    expect(createNip98AuthHeader).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      'GET',
      null,
      expect.objectContaining({ priority: 'normal' }),
    );
    expect(createNip98AuthHeader).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/me',
      'GET',
      null,
      expect.objectContaining({ priority: 'normal' }),
    );
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('updates Tower PG workspace profile metadata with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.updateTowerPgWorkspace('workspace-1', {
      name: 'Testing Space',
      slug: 'testing-space',
      description: 'Workspace profile',
      avatar_url: null,
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          name: 'Testing Space',
          slug: 'testing-space',
          description: 'Workspace profile',
          avatar_url: null,
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('calls Tower PG workroom list, create, detail, and lifecycle routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.searchTowerPgWorkrooms('workspace-1', {
      query: 'release',
      scopeId: 'scope-1',
      channelId: 'channel-1',
      limit: 20,
      appNpub: 'flightdeck_pg',
    });
    await api.getTowerPgWorkrooms('workspace-1', {
      channelId: 'channel-1',
      status: 'active',
      limit: 25,
      appNpub: 'flightdeck_pg',
    });
    await api.createTowerPgWorkroom('workspace-1', {
      channel_id: 'channel-1',
      title: 'Release room',
      goal: 'Ship safely',
    }, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkroom('workspace-1', 'room-1', { limit: 50, appNpub: 'flightdeck_pg' });
    await api.updateTowerPgWorkroom('workspace-1', 'room-1', {
      title: 'Release room v2',
      row_version: 1,
    }, { appNpub: 'flightdeck_pg' });
    await api.startTowerPgWorkroom('workspace-1', 'room-1', { row_version: 2 }, { appNpub: 'flightdeck_pg' });
    await api.archiveTowerPgWorkroom('workspace-1', 'room-1', { row_version: 3 }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/search?q=release&scope_id=scope-1&channel_id=channel-1&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms?channel_id=channel-1&status=active&limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel_id: 'channel-1',
          title: 'Release room',
          goal: 'Ship safely',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1?limit=50',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Release room v2', row_version: 1 }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      6,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ row_version: 2 }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      7,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/archive',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ row_version: 3 }) }),
    );
  });

  it('calls Tower PG workroom child and approval routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkroomParticipants('workspace-1', 'room-1', { appNpub: 'flightdeck_pg' });
    await api.createTowerPgWorkroomParticipant('workspace-1', 'room-1', {
      actor_npub: 'npub1reviewer',
      role: 'human_approver',
    }, { appNpub: 'flightdeck_pg' });
    await api.updateTowerPgWorkroomParticipant('workspace-1', 'room-1', 'participant-1', {
      access_status: 'granted',
    }, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkroomEvents('workspace-1', 'room-1', { limit: 10, appNpub: 'flightdeck_pg' });
    await api.createTowerPgWorkroomEvent('workspace-1', 'room-1', {
      event_type: 'note',
      title: 'Ready',
    }, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWorkroomLinks('workspace-1', 'room-1', { limit: 15, appNpub: 'flightdeck_pg' });
    await api.createTowerPgWorkroomLink('workspace-1', 'room-1', {
      link_type: 'pull_request',
      target_type: 'external',
      external_url: 'https://github.example/pr/1',
    }, { appNpub: 'flightdeck_pg' });
    await api.createTowerPgWorkroomApproval('workspace-1', 'room-1', {
      action: 'production_merge',
      metadata: { to_branch: 'main', commit: 'abc123' },
    }, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgApprovals('workspace-1', {
      targetType: 'workroom',
      targetId: 'room-1',
      status: 'requested',
      appNpub: 'flightdeck_pg',
    });
    await api.getTowerPgApproval('workspace-1', 'approval-1', { appNpub: 'flightdeck_pg' });
    await api.decideTowerPgApproval('workspace-1', 'approval-1', {
      status: 'approved',
      row_version: 1,
    }, { appNpub: 'flightdeck_pg' });
    await api.checkTowerPgProductionMergeApproval('workspace-1', 'room-1', {
      to_branch: 'main',
      commit: 'abc123',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/participants',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/participants',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ actor_npub: 'npub1reviewer', role: 'human_approver' }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/participants/participant-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ access_status: 'granted' }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/events?limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ event_type: 'note', title: 'Ready' }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      6,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/links?limit=15',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      7,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/links',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          link_type: 'pull_request',
          target_type: 'external',
          external_url: 'https://github.example/pr/1',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      8,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/approvals',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'production_merge',
          metadata: { to_branch: 'main', commit: 'abc123' },
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      9,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/approvals?target_type=workroom&target_id=room-1&status=requested&limit=100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      10,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/approvals/approval-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      11,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/approvals/approval-1/decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ status: 'approved', row_version: 1 }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      12,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/workrooms/room-1/production-merge/check',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ to_branch: 'main', commit: 'abc123' }),
      }),
    );
  });

  it('reads Tower PG document metadata and body with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgDoc('workspace-1', 'doc-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgDocBody('workspace-1', 'doc-1', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/body',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/body',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(2);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('reads Tower PG scope, channel, thread, message, and task lists with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkspaceScopes('workspace-1', { appNpub: 'flightdeck_pg', limit: 10 });
    await api.getTowerPgScopeChannels('workspace-1', 'scope-1', { appNpub: 'flightdeck_pg', limit: 20 });
    await api.getTowerPgChannelThreads('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 30 });
    await api.getTowerPgChannelMessages('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 40, cursor: 'next page' });
    await api.getTowerPgChannelTasks('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 50 });
    await api.getTowerPgScopeTasks('workspace-1', 'scope-1', { appNpub: 'flightdeck_pg', limit: 60 });
    await api.getTowerPgTaskComments('workspace-1', 'task-1', { appNpub: 'flightdeck_pg', limit: 70 });
    await api.getTowerPgChannelDocs('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 80 });
    await api.getTowerPgChannelFiles('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 90 });
    await api.getTowerPgChannelAudioNotes('workspace-1', 'channel-1', { appNpub: 'flightdeck_pg', limit: 100 });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes?limit=10',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes?limit=10',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1/channels?limit=20',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1/channels?limit=20',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/threads?limit=30',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/threads?limit=30',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages?limit=40&cursor=next+page',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/messages?limit=40&cursor=next+page',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/tasks?limit=50',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/tasks?limit=50',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      6,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1/tasks?limit=60',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1/tasks?limit=60',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      7,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments?limit=70',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments?limit=70',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      8,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/docs?limit=80',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/docs?limit=80',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      9,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/files?limit=90',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/files?limit=90',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      10,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/audio-notes?limit=100',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/audio-notes?limit=100',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(10);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('reorders a Tower PG channel with an interactive signed 1-based position write', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.reorderTowerPgChannel('workspace-1', 'channel-1', 3, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/reorder',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ position: 3 }),
        headers: expect.objectContaining({
          Authorization: 'NIP98 POST https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1/reorder',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    await expect(api.reorderTowerPgChannel('workspace-1', 'channel-1', 0, { appNpub: 'flightdeck_pg' }))
      .rejects.toThrow('positive 1-based integer');
  });

  it('creates Tower PG workspace scopes with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.createTowerPgWorkspaceScope('workspace-1', {
      name: 'Marketing',
      kind: 'project',
      description: 'Top-level marketing work area',
      owner_group_id: 'group-1',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'NIP98 POST https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          name: 'Marketing',
          kind: 'project',
          description: 'Top-level marketing work area',
          owner_group_id: 'group-1',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('updates Tower PG workspace scopes with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.updateTowerPgWorkspaceScope('workspace-1', 'scope-1', {
      name: 'Renamed scope',
      description: 'Updated',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({ name: 'Renamed scope', description: 'Updated' }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('creates Tower PG task comments with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.createTowerPgTaskComment('workspace-1', 'task-1', {
      body: 'Task comment',
      thread_id: 'thread-1',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'NIP98 POST https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/comments',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          body: 'Task comment',
          thread_id: 'thread-1',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('creates admin Flight Deck PG workspaces with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.createTowerPgAdminWorkspace({
      creator_npub: 'npub1personalcreator',
      workspace_name: 'Operator A docs',
      workspace_description: 'PG workspace',
      app_npub: 'flightdeck_pg',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/admin/flightdeck-pg/workspaces',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'NIP98 POST https://tower.example/api/v4/admin/flightdeck-pg/workspaces',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          creator_npub: 'npub1personalcreator',
          workspace_name: 'Operator A docs',
          workspace_description: 'PG workspace',
          app_npub: 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('calls Tower PG workspace admin group and member routes', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgWorkspaceMembers('workspace-1', { appNpub: 'flightdeck_pg', limit: 25 });
    await api.getTowerPgWorkspaceGroups('workspace-1', { appNpub: 'flightdeck_pg', limit: 26 });
    await api.createTowerPgWorkspaceMember('workspace-1', { member_npub: 'npub1member' }, { appNpub: 'flightdeck_pg' });
    await api.createTowerPgWorkspaceGroup('workspace-1', { name: 'Editors' }, { appNpub: 'flightdeck_pg' });
    await api.addTowerPgWorkspaceGroupMember('workspace-1', 'group-1', { member_npub: 'npub1member' }, { appNpub: 'flightdeck_pg' });
    await api.removeTowerPgWorkspaceGroupMember('workspace-1', 'group-1', 'actor-1', { appNpub: 'flightdeck_pg' });
    await api.addTowerPgWorkspaceChildGroup('workspace-1', 'parent-1', { child_group_id: 'child-1' }, { appNpub: 'flightdeck_pg' });
    await api.removeTowerPgWorkspaceChildGroup('workspace-1', 'parent-1', 'child-1', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/members?limit=25',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups?limit=26',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/members',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups/group-1/members',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      6,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups/group-1/members/actor-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      7,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups/parent-1/child-groups',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      8,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/groups/parent-1/child-groups/child-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(8);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('sends channel DELETE with NIP-98 scoped to the final public URL and method', async () => {
    const { createNip98AuthHeader } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');

    await api.deleteTowerPgChannel('workspace-1', 'channel-1', {
      baseUrl: 'https://tower.example.com/',
      appNpub: 'flightdeck_pg',
    });

    const requestUrl = 'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-1';
    expect(createNip98AuthHeader).toHaveBeenCalledWith(
      requestUrl,
      'DELETE',
      null,
      expect.objectContaining({ signTimeoutMs: 45_000, priority: 'high' }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      requestUrl,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: `NIP98 DELETE ${requestUrl}`,
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
  });

  it('calls Tower PG edit lease inspect, acquire, renew, and release routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgEditLease('workspace-1', {
      entityType: 'document',
      entityId: 'doc-1',
      appNpub: 'flightdeck_pg',
    });
    await api.acquireTowerPgEditLease('workspace-1', {
      entity_type: 'task',
      entity_id: 'task-1',
    }, { appNpub: 'flightdeck_pg' });
    await api.renewTowerPgEditLease('workspace-1', 'lease-1', {
      lease_token: 'token-1',
    }, { appNpub: 'flightdeck_pg' });
    await api.releaseTowerPgEditLease('workspace-1', 'lease-1', {
      lease_token: 'token-1',
    }, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases?entity_type=document&entity_id=doc-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases/acquire',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ entity_type: 'task', entity_id: 'task-1' }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases/lease-1/renew',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ lease_token: 'token-1' }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/edit-leases/lease-1/release',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ lease_token: 'token-1' }),
      }),
    );
  });

  it('preserves lease-holder details from acquire conflicts for recovery UI', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({
        code: 'edit_lease_held',
        error: 'edit lease is held',
        holder_actor_npub: 'npub1holder',
        holder_display_name: 'Lease holder',
        expires_at: '2026-08-25T13:00:00.000Z',
      }),
    }));

    await expect(api.acquireTowerPgEditLease('workspace-1', {
      entity_type: 'document',
      entity_id: 'doc-1',
    }, { appNpub: 'flightdeck_pg' })).rejects.toMatchObject({
      status: 409,
      code: 'edit_lease_held',
      holder_actor_npub: 'npub1holder',
      holder_display_name: 'Lease holder',
      expires_at: '2026-08-25T13:00:00.000Z',
      payload: expect.objectContaining({ code: 'edit_lease_held' }),
    });
  });

  it('uses the typed document recovery read and resolution routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const promotion = {
      row_version: 9,
      base_version_id: 'doc-1:9',
      base_body_sha256_hex: 'a'.repeat(64),
      lease_token: 'lease-current-head',
    };

    await api.getTowerPgDocRecoveries('workspace-1', 'doc-1', {
      appNpub: 'flightdeck_pg',
      state: 'all',
      limit: 25,
    });
    await api.getTowerPgDocRecovery('workspace-1', 'doc-1', 'recovery-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgDocRecoveryBody('workspace-1', 'doc-1', 'recovery-1', { appNpub: 'flightdeck_pg' });
    await api.promoteTowerPgDocRecovery('workspace-1', 'doc-1', 'recovery-1', promotion, { appNpub: 'flightdeck_pg' });
    await api.discardTowerPgDocRecovery('workspace-1', 'doc-1', 'recovery-1', { appNpub: 'flightdeck_pg' });

    const root = 'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/recoveries';
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, `${root}?state=all&limit=25`, expect.objectContaining({ method: 'GET' }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, `${root}/recovery-1`, expect.objectContaining({ method: 'GET' }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3, `${root}/recovery-1/body`, expect.objectContaining({ method: 'GET' }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4, `${root}/recovery-1/promote`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(promotion),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(5, `${root}/recovery-1/discard`, expect.objectContaining({
      method: 'POST',
    }));
    expect(globalThis.fetch.mock.calls[4][1].body).toBeUndefined();
  });

  it('reads and creates Tower PG document comments with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgDocComments('workspace-1', 'doc-1', {
      appNpub: 'flightdeck_pg',
      limit: 40,
    });
    await api.getTowerPgDocVersions('workspace-1', 'doc-1', {
      appNpub: 'flightdeck_pg',
      limit: 20,
    });
    await api.createTowerPgDocComment('workspace-1', 'doc-1', {
      body: 'Doc comment',
      parent_comment_id: 'comment-1',
      metadata: {
        anchor_block_id: 'block-1',
        anchor_line_number: 4,
        anchor_end_line_number: 5,
        anchor_quote: 'Selected\nquote',
        anchor_start_offset: 10,
        anchor_end_offset: 26,
      },
    }, { appNpub: 'flightdeck_pg' });
    await api.updateTowerPgDocComment('workspace-1', 'doc-1', 'comment-1', {
      comment_status: 'resolved',
      row_version: 2,
    }, { appNpub: 'flightdeck_pg' });
    await api.deleteTowerPgDocComment('workspace-1', 'doc-1', 'comment-1', {
      appNpub: 'flightdeck_pg',
      rowVersion: 3,
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments?limit=40',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments?limit=40',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/versions?limit=20',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/versions?limit=20',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'NIP98 POST https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          body: 'Doc comment',
          parent_comment_id: 'comment-1',
          metadata: {
            anchor_block_id: 'block-1',
            anchor_line_number: 4,
            anchor_end_line_number: 5,
            anchor_quote: 'Selected\nquote',
            anchor_start_offset: 10,
            anchor_end_offset: 26,
          },
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments/comment-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments/comment-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify({
          comment_status: 'resolved',
          row_version: 2,
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments/comment-1?row_version=3',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'NIP98 DELETE https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/comments/comment-1?row_version=3',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(5);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('reads Tower PG Daily Scope versions with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.getTowerPgDailyNoteVersions('workspace-1', 'daily-1', {
      appNpub: 'flightdeck_pg',
      limit: 25,
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes/daily-1/versions?limit=25',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'NIP98 GET https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes/daily-1/versions?limit=25',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('upserts Tower PG Daily Scope with the active workspace key signer', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const workspaceSecret = new Uint8Array([4, 5, 6]);
    getActiveWorkspaceKeySecretForAuth.mockReturnValueOnce(workspaceSecret);
    const body = {
      note_date: '2026-06-24',
      title: 'Daily note',
      body: 'Mobile note',
      items: [],
      status: 'active',
    };

    await api.upsertTowerPgDailyNote('workspace-1', body, {
      appNpub: 'flightdeck_pg',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'NIP98-SECRET POST https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify(body),
      }),
    );
    expect(createNip98AuthHeaderForSecret).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes',
      'POST',
      body,
      workspaceSecret,
    );
    expect(createNip98AuthHeader).not.toHaveBeenCalled();
  });

  it('deletes Tower PG messages and threads with browser NIP-98 auth', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');

    await api.deleteTowerPgMessage('workspace-1', 'message-1', {
      appNpub: 'flightdeck_pg',
      rowVersion: 3,
    });
    await api.deleteTowerPgThread('workspace-1', 'thread-1', {
      appNpub: 'flightdeck_pg',
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1?row_version=3',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'NIP98 DELETE https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1?row_version=3',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/threads/thread-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'NIP98 DELETE https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/threads/thread-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeader).toHaveBeenCalledTimes(2);
    expect(createNip98AuthHeaderForSecret).not.toHaveBeenCalled();
  });

  it('reads a single Tower PG message through the signed typed workspace route', async () => {
    const api = await import('../src/api.js'); api.setBaseUrl('https://tower.example');
    await api.getTowerPgMessage('workspace-1', 'message-1', { appNpub: 'flightdeck_pg' });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1', expect.objectContaining({ method: 'GET' }));
  });

  it('reads and renames Tower PG threads with browser NIP-98 auth', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    await api.getTowerPgThread('workspace-1', 'thread-1', { appNpub: 'flightdeck_pg' });
    await api.updateTowerPgThread('workspace-1', 'thread-1', { title: 'Renamed', row_version: 2 }, { appNpub: 'flightdeck_pg' });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/threads/thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/threads/thread-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed', row_version: 2 }) }),
    );
  });

  it('patches Tower PG message revisions with browser NIP-98 auth', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const body = {
      body: 'Revised',
      row_version: 3,
      mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
      message_signature: { version: 1, body_sha256: 'abc' },
    };

    await api.updateTowerPgMessage('workspace-1', 'message-1', body, {
      appNpub: 'flightdeck_pg',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'NIP98 PATCH https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
        body: JSON.stringify(body),
      }),
    );
  });

  it('prefers the active workspace key for Tower PG message deletes', async () => {
    const { createNip98AuthHeader, createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    getActiveWorkspaceKeySecretForAuth.mockReturnValueOnce(new Uint8Array([1, 2, 3]));

    await api.deleteTowerPgMessage('workspace-1', 'message-1', {
      appNpub: 'flightdeck_pg',
      rowVersion: 3,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1?row_version=3',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'NIP98-SECRET DELETE https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/messages/message-1?row_version=3',
          'x-flightdeck-pg-app-npub': 'flightdeck_pg',
        }),
      }),
    );
    expect(createNip98AuthHeaderForSecret).toHaveBeenCalledTimes(1);
    expect(createNip98AuthHeader).not.toHaveBeenCalled();
  });

  it('keeps workspace-key auth bounded and does not fetch when signing does not settle', async () => {
    vi.useFakeTimers();
    const { createNip98AuthHeaderForSecret } = await import('../src/auth/nostr.js');
    const { getActiveWorkspaceKeySecretForAuth } = await import('../src/crypto/workspace-keys.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    getActiveWorkspaceKeySecretForAuth.mockReturnValueOnce(new Uint8Array([1, 2, 3]));
    createNip98AuthHeaderForSecret.mockImplementationOnce(() => new Promise(() => {}));

    const deletion = api.deleteTowerPgMessage('workspace-1', 'message-1', {
      appNpub: 'flightdeck_pg',
      rowVersion: 3,
    });
    const assertion = expect(deletion).rejects.toMatchObject({
      code: 'auth_timeout',
      message: expect.stringContaining('NIP-98 signing timed out for DELETE'),
    });

    await vi.advanceTimersByTimeAsync(45_000);

    await assertion;
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses a bounded normal-priority signing allowance for ordinary Tower PG reads', async () => {
    const { createNip98AuthHeader } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    await api.getTowerPgWorkspaceDescriptor('workspace-1', { appNpub: 'flightdeck_pg' });

    expect(createNip98AuthHeader).toHaveBeenCalledWith(
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor',
      'GET',
      null,
      expect.objectContaining({ signTimeoutMs: 10_000, priority: 'normal' }),
    );
  });

  it('does not fetch when browser auth cannot be produced', async () => {
    const { createNip98AuthHeader } = await import('../src/auth/nostr.js');
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    createNip98AuthHeader.mockRejectedValueOnce(new Error('NIP-07 signing timed out.'));

    await expect(
      api.getTowerPgWorkspaceDescriptor('workspace-1', { appNpub: 'flightdeck_pg' }),
    ).rejects.toThrow('NIP-07 signing timed out.');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls the explicit task and document move routes with destination placement', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const taskBody = { destination_channel_id: 'channel-2', destination_scope_id: 'scope-2', row_version: 3 };
    const docBody = { destination_channel_id: 'channel-3', destination_scope_id: 'scope-3', row_version: 4 };
    await api.moveTowerPgTask('workspace-1', 'task-1', taskBody, { appNpub: 'flightdeck_pg' });
    await api.moveTowerPgDoc('workspace-1', 'doc-1', docBody, { appNpub: 'flightdeck_pg' });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/tasks/task-1/move',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(taskBody) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/docs/doc-1/move',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(docBody) }),
    );
  });

  it('passes publishing installation metadata through the typed Personal WApp create and update routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const body = {
      title: 'Linked Out',
      launch_url: 'https://linked-out.example',
      description: 'Linked Out launcher',
      icon_url: null,
      app_id: 'app-1',
      wapp_id: 'assignment-1',
      source_wingman_url: 'https://wingman.example',
      metadata: { wapp_installation_id: 'installation-1' },
    };

    await api.createTowerPgPersonalWapp('workspace-1', body, { appNpub: 'flightdeck_pg' });
    await api.updateTowerPgPersonalWapp('workspace-1', 'personal-wapp-1', body, { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/personal-wapps/personal-wapp-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(body) }),
    );
  });

  it('uses the final Tower WApp grant, feed, state, and mute routes', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    const grantBody = {
      app_id: 'app-1',
      publisher_npub: 'npub1publisher',
      owner_npub: 'npub1owner',
      display_name: 'Kindling',
      capabilities: ['activity.publish'],
      destinations: [{ scope_id: 'scope-1', channel_id: 'channel-1' }],
      registered_open_origins: ['https://kindling.example'],
    };

    await api.getTowerPgWappPublishingGrants('workspace-1', { appNpub: 'flightdeck_pg' });
    await api.putTowerPgWappPublishingGrant('workspace-1', 'installation-1', grantBody, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWappActivityItems('workspace-1', {
      appNpub: 'flightdeck_pg', unread: true, installationId: 'installation-1', category: 'lead', channelId: 'channel-1', cursor: 'next', limit: 25,
    });
    await api.patchTowerPgWappActivityUserState('workspace-1', 'item-1', { read: true }, { appNpub: 'flightdeck_pg' });
    await api.putTowerPgWappActivityMute('workspace-1', 'category', 'lead follow-up', {}, { appNpub: 'flightdeck_pg' });
    await api.deleteTowerPgWappActivityMute('workspace-1', 'category', 'lead follow-up', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants/installation-1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(grantBody) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/items?unread=true&installation_id=installation-1&category=lead&channel_id=channel-1&cursor=next&limit=25&include_resolved=true',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/items/item-1/user-state',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ read: true }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(5,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/mutes/category/lead%20follow-up',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({}) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(6,
      'https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/mutes/category/lead%20follow-up',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('covers WApp grant lifecycle, item detail, counts, and mute reads', async () => {
    const api = await import('../src/api.js');
    api.setBaseUrl('https://tower.example');
    await api.getTowerPgWappPublishingGrant('workspace-1', 'installation-1', { appNpub: 'flightdeck_pg' });
    await api.disableTowerPgWappPublishingGrant('workspace-1', 'installation-1', { disabled: true }, { appNpub: 'flightdeck_pg' });
    await api.revokeTowerPgWappPublishingGrant('workspace-1', 'installation-1', { disable_open_links: true }, { appNpub: 'flightdeck_pg' });
    await api.rotateTowerPgWappPublishingGrant('workspace-1', 'installation-1', { current_publisher_npub: 'old', new_publisher_npub: 'new', nonce: 'n', expires_at: '2026-08-03T01:00:00Z' }, { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWappActivityItem('workspace-1', 'item-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWappActivityCounts('workspace-1', { appNpub: 'flightdeck_pg' });
    await api.getTowerPgWappActivityMutes('workspace-1', { appNpub: 'flightdeck_pg' });

    expect(globalThis.fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants/installation-1', 'GET'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants/installation-1/disable', 'POST'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants/installation-1/revoke', 'POST'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-publishing-grants/installation-1/rotate', 'POST'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/items/item-1', 'GET'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/counts', 'GET'],
      ['https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-1/wapp-activity/mutes', 'GET'],
    ]);
  });
});
