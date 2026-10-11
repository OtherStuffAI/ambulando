import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCommentsByTarget,
  openWorkspaceDb,
  replacePgCommentsForTarget,
  upsertComment,
} from '../src/db.js';

const TEST_OWNER = 'npub_test_comments_workspace';

beforeEach(async () => {
  const wsDb = openWorkspaceDb(TEST_OWNER);
  await wsDb.open();
  await Promise.all(wsDb.tables.map((table) => table.clear()));
});

describe('comment db helpers', () => {
  it('preserves pending PG comments when replacing the synced PG set for a target', async () => {
    await upsertComment({
      record_id: 'pending-comment',
      target_record_id: 'task-1',
      target_record_family_hash: 'app:task',
      body: 'Pending local comment',
      sender_npub: 'npub1sender',
      sync_status: 'pending',
      record_state: 'active',
      pg_backend: true,
      updated_at: '2026-06-23T00:02:00.000Z',
    });
    await upsertComment({
      record_id: 'synced-old',
      target_record_id: 'task-1',
      target_record_family_hash: 'app:task',
      body: 'Old synced comment',
      sender_npub: 'npub1sender',
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
      updated_at: '2026-06-23T00:01:00.000Z',
    });

    await replacePgCommentsForTarget('task-1', [{
      record_id: 'synced-new',
      target_record_id: 'task-1',
      target_record_family_hash: 'app:task',
      body: 'New synced comment',
      sender_npub: 'npub1sender',
      sync_status: 'synced',
      record_state: 'active',
      pg_backend: true,
      updated_at: '2026-06-23T00:00:00.000Z',
    }], { authoritative: true });

    const comments = await getCommentsByTarget('task-1');
    expect(comments.map((comment) => comment.record_id)).toEqual([
      'pending-comment',
      'synced-old',
      'synced-new',
    ]);
  });
});
