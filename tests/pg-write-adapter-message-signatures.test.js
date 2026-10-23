import { describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const pubkey = '1'.repeat(64);
  return {
    pubkey,
    createTowerPgChannelMessage: vi.fn(async (_workspaceId, channelId, body) => ({
      message: {
        id: 'message-1',
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: channelId,
        thread_id: body.thread_id ?? 'thread-created-1',
        body: body.body,
        row_version: 1,
        created_by_actor_id: 'actor-1',
        updated_by_actor_id: 'actor-1',
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:00:00.000Z',
      },
      thread: null,
    })),
    updateTowerPgMessage: vi.fn(async (_workspaceId, messageId, body) => ({
      message: {
        id: messageId,
        workspace_id: 'workspace-1',
        scope_id: 'scope-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        body: body.body,
        row_version: body.row_version + 1,
        created_by_actor_npub: 'npub1sender',
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:05:00.000Z',
      },
    })),
  };
});

vi.mock('../src/api.js', () => ({
  createTowerPgChannelAudioNote: vi.fn(),
  createTowerPgChannelDoc: vi.fn(),
  createTowerPgChannelFile: vi.fn(),
  createTowerPgChannelMessage: mockState.createTowerPgChannelMessage,
  createTowerPgChannelTask: vi.fn(),
  createTowerPgTaskComment: vi.fn(),
  deleteTowerPgDoc: vi.fn(),
  updateTowerPgDoc: vi.fn(),
  updateTowerPgTask: vi.fn(),
  updateTowerPgTaskState: vi.fn(),
  updateTowerPgMessage: mockState.updateTowerPgMessage,
}));

vi.mock('../src/auth/nostr.js', () => ({
  signNostrEvent: vi.fn(async (template) => ({
    ...template,
    id: '2'.repeat(64),
    pubkey: mockState.pubkey,
    sig: '3'.repeat(128),
  })),
}));

import { signNostrEvent } from '../src/auth/nostr.js';

import { createTowerPgMessageFromLocal, updateTowerPgMessageFromLocal } from '../src/pg-write-adapter.js';

describe('createTowerPgMessageFromLocal', () => {
  it('sends a signed agent instruction with the PG chat message body', async () => {
    await createTowerPgMessageFromLocal({
      backendUrl: 'https://tower.example.com',
      session: { npub: 'npub1sender' },
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1workspace',
        appNpub: 'npub1app',
      },
    }, {
      channel_id: 'channel-1',
      body: 'Run this task',
    }, {
      threadId: 'thread-1',
    });

    expect(mockState.createTowerPgChannelMessage).toHaveBeenCalledTimes(1);
    const [, , requestBody] = mockState.createTowerPgChannelMessage.mock.calls[0];
    const signature = requestBody.message_signature;
    expect(requestBody.body).toBe('Run this task');
    expect(signature).toMatchObject({
      version: 1,
      protocol: 'flightdeck_pg_message_instruction',
      kind: 33358,
      nostr_event: {
        kind: 33358,
        pubkey: mockState.pubkey,
        content: 'Run this task',
      },
    });
    expect(signature.nostr_event.tags).toEqual(expect.arrayContaining([
      ['protocol', 'flightdeck_pg_message_instruction'],
      ['workspace_id', 'workspace-1'],
      ['channel_id', 'channel-1'],
      ['thread_id', 'thread-1'],
    ]));
  });
});

describe('updateTowerPgMessageFromLocal', () => {
  it('binds an edit signature to the message id and next saved revision', async () => {
    await updateTowerPgMessageFromLocal({
      backendUrl: 'https://tower.example.com',
      session: { npub: 'npub1sender' },
      currentWorkspace: {
        workspaceId: 'workspace-1',
        workspaceOwnerNpub: 'npub1workspace',
        appNpub: 'npub1app',
      },
    }, {
      record_id: 'message-1',
      channel_id: 'channel-1',
      pg_thread_id: 'thread-1',
      version: 7,
    }, {
      body: 'Revised instruction',
      mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
    });

    const [, , requestBody] = mockState.updateTowerPgMessage.mock.calls[0];
    expect(requestBody).toMatchObject({
      body: 'Revised instruction',
      row_version: 7,
      mentions: [{ type: 'agent', npub: 'npub1testagent', label: 'Test Agent' }],
      message_signature: { message_id: 'message-1', revision: 8 },
    });
    expect(requestBody.message_signature.nostr_event.tags).toEqual(expect.arrayContaining([
      ['message_id', 'message-1'],
      ['revision', '8'],
      ['thread_id', 'thread-1'],
    ]));
  });
});

it('maps a successful create_thread response without a thread expansion as the source root', async () => {
  const row = await createTowerPgMessageFromLocal({
    backendUrl: 'https://tower.example.com', session: { npub: 'npub1sender' },
    currentWorkspace: { workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1workspace', appNpub: 'npub1app' },
  }, { record_id: 'local-root', pg_client_request_id: 'local-root', channel_id: 'channel-1', body: 'Root body' });
  expect(row).toMatchObject({ record_id: 'message-1', parent_message_id: null, pg_thread_id: 'thread-created-1' });
});


it('waits for instruction signing before delivery and preserves agent mentions and retry identity', async () => {
  let finishSigning;
  signNostrEvent.mockImplementationOnce(template => new Promise(resolve => {
    finishSigning = () => resolve({ ...template, id: '2'.repeat(64), pubkey: mockState.pubkey, sig: '3'.repeat(128) });
  }));
  const before = mockState.createTowerPgChannelMessage.mock.calls.length;
  const mentions = [{ type: 'agent', npub: 'npub1agent', label: 'Agent' }];
  const send = createTowerPgMessageFromLocal({ backendUrl: 'https://tower.example.com', session: { npub: 'npub1sender' },
    currentWorkspace: { workspaceId: 'workspace-1', workspaceOwnerNpub: 'npub1workspace', appNpub: 'npub1app' } },
    { record_id: 'local', pg_client_request_id: 'retry-key', channel_id: 'channel-1', body: '@[Agent](mention:agent:npub1agent) Go', pg_metadata: { mentions } });
  await vi.waitFor(() => expect(finishSigning).toBeTypeOf('function'));
  expect(mockState.createTowerPgChannelMessage.mock.calls).toHaveLength(before);
  finishSigning();
  await send;
  expect(mockState.createTowerPgChannelMessage.mock.calls.at(-1)[2]).toMatchObject({
    client_request_id: 'retry-key', create_thread: true, metadata: { mentions },
    message_signature: { nostr_event: { content: '@[Agent](mention:agent:npub1agent) Go' } },
  });
});
