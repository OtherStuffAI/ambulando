import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/translators/record-crypto.js', () => ({
  decryptRecordPayload: vi.fn(async (record) => JSON.parse(record.owner_payload.ciphertext)),
  encryptOwnerPayload: vi.fn(async (_ownerNpub, payload) => ({ ciphertext: JSON.stringify(payload) })),
  buildGroupPayloads: vi.fn(async (groupNpubs, payload) =>
    groupNpubs.map((group_npub) => ({ group_npub, ciphertext: JSON.stringify(payload), write: true }))),
}));
import {
  inboundTask,
  outboundTask,
  recordFamilyHash,
  computeParentState,
  stateColor,
  formatStateLabel,
  parseTags,
  parseReferencesFromDescription,
} from '../src/translators/tasks.js';
import { APP_NPUB } from '../src/app-identity.js';

describe('task translator — inbound', () => {
  it('materializes a task record into a local row', async () => {
    const record = {
      record_id: 'task-1',
      owner_npub: 'npub_owner',
      version: 2,
      created_at: '2026-03-10T00:00:00Z',
      updated_at: '2026-03-10T01:00:00Z',
      owner_payload: {
        ciphertext: JSON.stringify({
          app_namespace: APP_NPUB,
          collection_space: 'task',
          schema_version: 1,
          record_id: 'task-1',
          data: {
            title: 'Build task board',
            description: 'Port v3 board to v4',
            state: 'in_progress',
            priority: 'rock',
            board_order: 1250,
            parent_task_id: null,
            assigned_to_npub: 'npub_assignee',
            scheduled_for: '2026-03-15',
            tags: 'frontend,ui',
            record_state: 'active',
          },
        }),
      },
      group_payloads: [
        { group_npub: 'gpub_abc', ciphertext: '{}', write: true },
      ],
    };

    const row = await inboundTask(record);

    expect(row.record_id).toBe('task-1');
    expect(row.owner_npub).toBe('npub_owner');
    expect(row.title).toBe('Build task board');
    expect(row.description).toBe('Port v3 board to v4');
    expect(row.state).toBe('in_progress');
    expect(row.priority).toBe('rock');
    expect(row.board_order).toBe(1250);
    expect(row.parent_task_id).toBeNull();
    expect(row.assigned_to_npub).toBe('npub_assignee');
    expect(row.scheduled_for).toBe('2026-03-15');
    expect(row.tags).toBe('frontend,ui');
    expect(row.group_ids).toEqual(['gpub_abc']);
    expect(row.sync_status).toBe('synced');
    expect(row.record_state).toBe('active');
    expect(row.version).toBe(2);
  });

  it('handles subtask with parent_task_id', async () => {
    const record = {
      record_id: 'task-2',
      owner_npub: 'npub_owner',
      version: 1,
      updated_at: '2026-03-10T02:00:00Z',
      owner_payload: {
        ciphertext: JSON.stringify({
          data: {
            title: 'Design UI',
            state: 'new',
            parent_task_id: 'task-1',
          },
        }),
      },
      group_payloads: [],
    };

    const row = await inboundTask(record);

    expect(row.parent_task_id).toBe('task-1');
    expect(row.title).toBe('Design UI');
  });

  it('normalizes legacy board_group_id and shares to stable group ids when payloads include epoch metadata', async () => {
    const record = {
      record_id: 'task-legacy-board',
      owner_npub: 'npub_owner',
      version: 3,
      updated_at: '2026-03-16T08:29:59.365Z',
      owner_payload: {
        ciphertext: JSON.stringify({
          data: {
            title: 'Legacy board task',
            board_group_id: 'npub_old_epoch_1',
            shares: [
              {
                type: 'group',
                group_npub: 'npub_old_epoch_1',
                access: 'write',
              },
            ],
          },
        }),
      },
      group_payloads: [
        {
          group_id: 'group-uuid-1',
          group_epoch: 1,
          group_npub: 'npub_old_epoch_1',
          ciphertext: '{}',
          write: true,
        },
      ],
    };

    const row = await inboundTask(record);

    expect(row.board_group_id).toBe('group-uuid-1');
    expect(row.group_ids).toEqual(['group-uuid-1']);
    expect(row.shares).toEqual([
      expect.objectContaining({
        group_id: 'group-uuid-1',
        group_npub: 'npub_old_epoch_1',
      }),
    ]);
  });

  it('defaults missing fields', async () => {
    const record = {
      record_id: 'task-3',
      owner_npub: 'npub_owner',
      owner_payload: { ciphertext: JSON.stringify({ data: {} }) },
      group_payloads: [],
    };

    const row = await inboundTask(record);

    expect(row.title).toBe('');
    expect(row.state).toBe('new');
    expect(row.priority).toBe('sand');
    expect(row.board_order).toBeNull();
    expect(row.parent_task_id).toBeNull();
  });
});

describe('task translator — outbound', () => {
  it('builds a valid V4 envelope', async () => {
    const envelope = await outboundTask({
      record_id: 'task-1',
      owner_npub: 'npub_owner',
      title: 'Build board',
      description: 'Port v3',
      state: 'new',
      priority: 'rock',
      board_order: 2500,
      assigned_to_npub: 'npub_assignee',
      group_ids: ['gpub_abc'],
      signature_npub: 'npub_owner',
    });

    expect(envelope.record_id).toBe('task-1');
    expect(envelope.owner_npub).toBe('npub_owner');
    expect(envelope.record_family_hash).toBe(`${APP_NPUB}:task`);
    expect(envelope.version).toBe(1);
    expect(envelope.group_payloads).toHaveLength(1);
    expect(envelope.group_payloads[0].group_npub).toBe('gpub_abc');
    expect(envelope.group_payloads[0].write).toBe(true);

    const payload = JSON.parse(envelope.owner_payload.ciphertext);
    expect(payload.app_namespace).toBe(APP_NPUB);
    expect(payload.collection_space).toBe('task');
    expect(payload.data.title).toBe('Build board');
    expect(payload.data.state).toBe('new');
    expect(payload.data.priority).toBe('rock');
    expect(payload.data.board_order).toBe(2500);
    expect(payload.data.assigned_to_npub).toBe('npub_assignee');
  });

  it('includes soft-delete state', async () => {
    const envelope = await outboundTask({
      record_id: 'task-1',
      owner_npub: 'npub_owner',
      title: 'Deleted task',
      record_state: 'deleted',
      version: 2,
      previous_version: 1,
    });

    const payload = JSON.parse(envelope.owner_payload.ciphertext);
    expect(payload.data.record_state).toBe('deleted');
    expect(envelope.version).toBe(2);
    expect(envelope.previous_version).toBe(1);
  });

  it('uses write_group_npub when the writable group ref is not a UUID', async () => {
    const envelope = await outboundTask({
      record_id: 'task-legacy-group',
      owner_npub: 'npub_owner',
      title: 'Legacy group task',
      group_ids: ['group-uuid-1'],
      write_group_ref: 'npub1grouprefexample',
    });

    expect(envelope.write_group_id).toBeUndefined();
    expect(envelope.write_group_npub).toBe('npub1grouprefexample');
  });
});

describe('task translator — recordFamilyHash', () => {
  it('returns APP_NPUB:collectionSpace', () => {
    expect(recordFamilyHash('task')).toBe(`${APP_NPUB}:task`);
  });
});

describe('task helpers', () => {
  describe('computeParentState', () => {
    it('returns new for empty subtasks', () => {
      expect(computeParentState([])).toBe('new');
    });

    it('returns the least-advanced state', () => {
      const subtasks = [
        { state: 'done' },
        { state: 'in_progress' },
        { state: 'done' },
      ];
      expect(computeParentState(subtasks)).toBe('in_progress');
    });

    it('treats archive as done', () => {
      const subtasks = [
        { state: 'archive' },
        { state: 'done' },
      ];
      expect(computeParentState(subtasks)).toBe('done');
    });

    it('all done returns done', () => {
      const subtasks = [
        { state: 'done' },
        { state: 'done' },
      ];
      expect(computeParentState(subtasks)).toBe('done');
    });

    it('new subtask brings parent to new', () => {
      const subtasks = [
        { state: 'done' },
        { state: 'new' },
      ];
      expect(computeParentState(subtasks)).toBe('new');
    });

    it('derives blocked when it is the earliest remaining subtask state', () => {
      expect(computeParentState([
        { state: 'blocked' },
        { state: 'review' },
        { state: 'done' },
      ])).toBe('blocked');
    });
  });

  describe('stateColor', () => {
    it('returns the canonical default task status colours', () => {
      expect(stateColor('summary')).toBe('#a78bfa');
      expect(stateColor('new')).toBe('#9ca3af');
      expect(stateColor('ready')).toBe('#f87171');
      expect(stateColor('in_progress')).toBe('#fb923c');
      expect(stateColor('in progress')).toBe('#fb923c');
      expect(stateColor('blocked')).toBe('#c026d3');
      expect(stateColor('review')).toBe('#34d399');
      expect(stateColor('done')).toBe('#60a5fa');
      expect(stateColor('archive')).toBe('#60a5fa');
    });

    it('returns fallback for unknown', () => {
      expect(stateColor('unknown')).toBe('#9ca3af');
    });
  });

  describe('formatStateLabel', () => {
    it('formats in_progress', () => {
      expect(formatStateLabel('in_progress')).toBe('In Progress');
    });

    it('uses Backlog presentation and preserves other simple state labels', () => {
      expect(formatStateLabel('new')).toBe('Backlog');
      expect(formatStateLabel(' NEW ')).toBe('Backlog');
      expect(formatStateLabel('blocked')).toBe('Blocked');
      expect(formatStateLabel('done')).toBe('Done');
    });

    it('renders unknown historical states as readable labels', () => {
      expect(formatStateLabel('waiting_external')).toBe('Waiting External');
    });
  });

  describe('parseTags', () => {
    it('splits comma-separated tags', () => {
      expect(parseTags('frontend,ui,board')).toEqual(['frontend', 'ui', 'board']);
    });

    it('returns empty array for empty input', () => {
      expect(parseTags('')).toEqual([]);
      expect(parseTags(null)).toEqual([]);
    });

    it('trims and lowercases', () => {
      expect(parseTags(' Frontend , UI ')).toEqual(['frontend', 'ui']);
    });
  });

  describe('parseReferencesFromDescription', () => {
    it('extracts task references from description text', () => {
      const desc = 'See @[Build board](mention:task:task-1) for context';
      expect(parseReferencesFromDescription(desc)).toEqual([
        { type: 'task', id: 'task-1' },
      ]);
    });

    it('extracts doc references', () => {
      const desc = 'Refer to @[Spec doc](mention:doc:doc-abc)';
      expect(parseReferencesFromDescription(desc)).toEqual([
        { type: 'doc', id: 'doc-abc' },
      ]);
    });

    it('extracts scope references', () => {
      const desc = 'Scope: @[Product X](mention:scope:scope-1)';
      expect(parseReferencesFromDescription(desc)).toEqual([
        { type: 'scope', id: 'scope-1' },
      ]);
    });

    it('extracts multiple references and deduplicates', () => {
      const desc = '@[Task A](mention:task:t1) and @[Doc B](mention:doc:d1) and @[Task A](mention:task:t1)';
      expect(parseReferencesFromDescription(desc)).toEqual([
        { type: 'task', id: 't1' },
        { type: 'doc', id: 'd1' },
      ]);
    });

    it('skips person mentions', () => {
      const desc = '@[Alice](mention:person:npub1abc) assigned this';
      expect(parseReferencesFromDescription(desc)).toEqual([]);
    });

    it('returns empty array for null/empty description', () => {
      expect(parseReferencesFromDescription(null)).toEqual([]);
      expect(parseReferencesFromDescription('')).toEqual([]);
    });

    it('returns empty array when no mention tokens present', () => {
      expect(parseReferencesFromDescription('Just a plain description')).toEqual([]);
    });
  });
});

describe('task translator — references round-trip', () => {
  it('inbound preserves references array from payload', async () => {
    const refs = [
      { type: 'task', id: 'task-99' },
      { type: 'doc', id: 'doc-42' },
    ];
    const record = {
      record_id: 'task-refs',
      owner_npub: 'npub_owner',
      version: 1,
      updated_at: '2026-03-28T00:00:00Z',
      owner_payload: {
        ciphertext: JSON.stringify({
          data: {
            title: 'Task with refs',
            references: refs,
          },
        }),
      },
      group_payloads: [],
    };
    const row = await inboundTask(record);
    expect(row.references).toEqual(refs);
  });

  it('inbound defaults references to empty array when missing', async () => {
    const record = {
      record_id: 'task-no-refs',
      owner_npub: 'npub_owner',
      version: 1,
      owner_payload: {
        ciphertext: JSON.stringify({ data: { title: 'No refs' } }),
      },
      group_payloads: [],
    };
    const row = await inboundTask(record);
    expect(row.references).toEqual([]);
  });

  it('outbound includes references in the envelope payload', async () => {
    const refs = [{ type: 'task', id: 't-1' }, { type: 'scope', id: 's-1' }];
    const envelope = await outboundTask({
      record_id: 'task-out-refs',
      owner_npub: 'npub_owner',
      title: 'Outbound refs',
      references: refs,
    });
    const payload = JSON.parse(envelope.owner_payload.ciphertext);
    expect(payload.data.references).toEqual(refs);
  });

  it('round-trips source and deliverable links alongside references', async () => {
    const sourceLinks = [{ type: 'task', id: 'source-task' }];
    const references = [{ type: 'doc', id: 'ref-doc' }];
    const deliverableLinks = [{ type: 'doc', id: 'out-doc', order: 1 }];

    const envelope = await outboundTask({
      record_id: 'task-link-model',
      owner_npub: 'npub_owner',
      title: 'Linked task',
      source_links: sourceLinks,
      references,
      deliverable_links: deliverableLinks,
    });
    const payload = JSON.parse(envelope.owner_payload.ciphertext);
    expect(payload.data.source_links).toEqual(sourceLinks);
    expect(payload.data.references).toEqual(references);
    expect(payload.data.deliverable_links).toEqual(deliverableLinks);

    const row = await inboundTask({
      record_id: 'task-link-model',
      owner_npub: 'npub_owner',
      owner_payload: envelope.owner_payload,
      group_payloads: [],
    });
    expect(row.source_links).toEqual(sourceLinks);
    expect(row.references).toEqual(references);
    expect(row.deliverable_links).toEqual(deliverableLinks);
  });
});
