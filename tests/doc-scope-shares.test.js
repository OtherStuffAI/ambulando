/**
 * Tests for document scope share inheritance.
 *
 * When a scope is assigned to a document (directly or via parent directory),
 * the scope's group_ids must be merged into the document's shares and group_ids.
 * This mirrors how buildTaskBoardAssignment works for tasks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/translators/record-crypto.js', () => ({
  decryptRecordPayload: vi.fn(async (record) => JSON.parse(record.owner_payload.ciphertext)),
  encryptOwnerPayload: vi.fn(async (_ownerNpub, payload) => ({ ciphertext: JSON.stringify(payload) })),
  buildGroupPayloads: vi.fn(async (groupNpubs, payload, canWriteByGroup) =>
    groupNpubs.map((group_npub) => ({
      group_npub,
      ciphertext: JSON.stringify(payload),
      write: canWriteByGroup instanceof Map ? canWriteByGroup.get(group_npub) === true : true,
    }))),
}));

vi.mock('../src/db.js', async (importOriginal) => ({
  ...await importOriginal(),
  upsertDocument: vi.fn(async () => {}),
  upsertDirectory: vi.fn(async () => {}),
  upsertScope: vi.fn(async () => {}),
  addPendingWrite: vi.fn(async () => {}),
  getCommentsByTarget: vi.fn(async () => []),
}));

import {
  mergeDocShareLists,
  getShareGroupIds,
  getStoredDocShares,
  normalizeDocShare,
} from '../src/docs-manager.js';
import { buildScopeShares, normalizeGroupIds } from '../src/scope-delivery.js';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeScope(id, level, parentId = null, extras = {}) {
  return {
    record_id: id,
    level,
    title: extras.title ?? id,
    description: extras.description ?? '',
    parent_id: parentId,
    l1_id: extras.l1_id ?? null,
    l2_id: extras.l2_id ?? null,
    l3_id: extras.l3_id ?? null,
    l4_id: extras.l4_id ?? null,
    l5_id: extras.l5_id ?? null,
    group_ids: extras.group_ids ?? [],
    record_state: extras.record_state ?? 'active',
  };
}

function makeGroup(id, name = '') {
  return {
    group_id: id,
    group_npub: id,
    name: name || `Group ${id}`,
  };
}

function makeScopesMap(...scopes) {
  return new Map(scopes.map(s => [s.record_id, s]));
}

// ---------------------------------------------------------------------------
// 1. buildScopeShares produces shares from scope group_ids
// ---------------------------------------------------------------------------

describe('buildScopeShares from scope group_ids', () => {
  it('creates group shares for each scope group_id', () => {
    const groups = [makeGroup('g1', 'Engineering'), makeGroup('g2', 'Design')];
    const shares = buildScopeShares(['g1', 'g2'], groups);
    expect(shares).toHaveLength(2);
    expect(shares[0]).toMatchObject({
      type: 'group',
      key: 'group:g1',
      access: 'write',
      group_npub: 'g1',
    });
    expect(shares[1]).toMatchObject({
      type: 'group',
      key: 'group:g2',
      access: 'write',
      group_npub: 'g2',
    });
  });

  it('returns empty for empty group_ids', () => {
    expect(buildScopeShares([], [])).toEqual([]);
  });

  it('resolves group labels from known groups', () => {
    const groups = [makeGroup('g1', 'Engineering')];
    const shares = buildScopeShares(['g1'], groups);
    expect(shares[0].label).toBe('Engineering');
  });
});

// ---------------------------------------------------------------------------
// 2. mergeDocShareLists correctly combines scope shares with existing shares
// ---------------------------------------------------------------------------

describe('merging scope shares into document shares', () => {
  it('adds scope group shares when doc has no existing shares', () => {
    const scopeShares = buildScopeShares(['g1'], [makeGroup('g1')]);
    const merged = mergeDocShareLists([], scopeShares);
    expect(merged).toHaveLength(1);
    expect(merged[0].group_npub).toBe('g1');
  });

  it('preserves existing doc shares when adding scope shares', () => {
    const existing = [
      normalizeDocShare({ type: 'person', person_npub: 'npub_alice', access: 'write' }),
    ];
    const scopeShares = buildScopeShares(['g1'], [makeGroup('g1')]);
    const merged = mergeDocShareLists(existing, scopeShares);
    expect(merged).toHaveLength(2);
    expect(merged.find(s => s.person_npub === 'npub_alice')).toBeTruthy();
    expect(merged.find(s => s.group_npub === 'g1')).toBeTruthy();
  });

  it('does not duplicate scope group shares already present on doc', () => {
    const existing = [
      normalizeDocShare({ type: 'group', group_npub: 'g1', access: 'write' }),
    ];
    const scopeShares = buildScopeShares(['g1'], [makeGroup('g1')]);
    const merged = mergeDocShareLists(existing, scopeShares);
    expect(merged).toHaveLength(1);
    expect(merged[0].group_npub).toBe('g1');
    expect(merged[0].access).toBe('write');
  });

  it('getShareGroupIds extracts correct group_ids from merged shares', () => {
    const scopeShares = buildScopeShares(['g1', 'g2'], [makeGroup('g1'), makeGroup('g2')]);
    const existing = [
      normalizeDocShare({ type: 'person', person_npub: 'npub_alice', via_group_npub: 'g3', access: 'read' }),
    ];
    const merged = mergeDocShareLists(existing, scopeShares);
    const groupIds = getShareGroupIds(merged);
    expect(groupIds).toContain('g1');
    expect(groupIds).toContain('g2');
    expect(groupIds).toContain('g3');
  });
});

// ---------------------------------------------------------------------------
// 3. Simulate the updateDocScope fix: scope group merging into doc shares
// ---------------------------------------------------------------------------

describe('updateDocScope should merge scope shares', () => {
  /**
   * This simulates what updateDocScope should do:
   * 1. Read the scope's group_ids
   * 2. Build scope default shares
   * 3. Merge them into the existing doc shares
   * 4. Update group_ids
   */
  function simulateUpdateDocScopeShares(doc, scopeId, scopesMap, groups) {
    const scope = scopeId ? scopesMap.get(scopeId) : null;
    const existingShares = getStoredDocShares(doc);

    if (!scope) {
      // Clearing scope — keep existing shares unchanged
      return { shares: existingShares, group_ids: getShareGroupIds(existingShares) };
    }

    const scopeGroupIds = normalizeGroupIds(scope.group_ids);
    const scopeShares = buildScopeShares(scopeGroupIds, groups);
    const merged = mergeDocShareLists(existingShares, scopeShares);
    return { shares: merged, group_ids: getShareGroupIds(merged) };
  }

  it('adds scope groups to a doc with no shares', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1'] });
    const scopesMap = makeScopesMap(scope);
    const doc = { record_id: 'doc-1', shares: [], group_ids: [] };

    const result = simulateUpdateDocScopeShares(doc, 'scope-1', scopesMap, [makeGroup('g1')]);
    expect(result.group_ids).toContain('g1');
    expect(result.shares).toHaveLength(1);
    expect(result.shares[0].group_npub).toBe('g1');
  });

  it('merges scope groups with existing doc shares', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1'] });
    const scopesMap = makeScopesMap(scope);
    const doc = {
      record_id: 'doc-1',
      shares: [{ type: 'group', key: 'group:g2', group_npub: 'g2', access: 'write' }],
      group_ids: ['g2'],
    };

    const result = simulateUpdateDocScopeShares(doc, 'scope-1', scopesMap, [makeGroup('g1'), makeGroup('g2')]);
    expect(result.group_ids).toContain('g1');
    expect(result.group_ids).toContain('g2');
    expect(result.shares).toHaveLength(2);
  });

  it('does not remove existing shares when scope has overlapping groups', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1'] });
    const scopesMap = makeScopesMap(scope);
    const doc = {
      record_id: 'doc-1',
      shares: [{ type: 'group', key: 'group:g1', group_npub: 'g1', access: 'read' }],
      group_ids: ['g1'],
    };

    const result = simulateUpdateDocScopeShares(doc, 'scope-1', scopesMap, [makeGroup('g1')]);
    expect(result.group_ids).toEqual(['g1']);
    // Access should be promoted to write (scope shares are write)
    expect(result.shares[0].access).toBe('write');
  });

  it('preserves shares when clearing scope (scopeId = null)', () => {
    const doc = {
      record_id: 'doc-1',
      shares: [{ type: 'group', key: 'group:g1', group_npub: 'g1', access: 'write' }],
      group_ids: ['g1'],
    };

    const result = simulateUpdateDocScopeShares(doc, null, new Map(), []);
    expect(result.group_ids).toEqual(['g1']);
    expect(result.shares).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Simulate createDocument fix: scope share inheritance at creation time
// ---------------------------------------------------------------------------

describe('createDocument should inherit scope shares from scoped directory', () => {
  /**
   * Simulates what createDocument should do when the parent directory
   * has a scope_id: merge scope default shares into inherited directory shares.
   */
  function simulateCreateDocShares(parentDirectory, scopesMap, groups, getInheritedShares) {
    const inherited = getInheritedShares(parentDirectory);
    const scopeId = parentDirectory?.scope_id || null;

    if (!scopeId) {
      return { shares: inherited, group_ids: getShareGroupIds(inherited) };
    }

    const scope = scopesMap.get(scopeId);
    if (!scope) {
      return { shares: inherited, group_ids: getShareGroupIds(inherited) };
    }

    const scopeGroupIds = normalizeGroupIds(scope.group_ids);
    const scopeShares = buildScopeShares(scopeGroupIds, groups);
    const merged = mergeDocShareLists(inherited, scopeShares);
    return { shares: merged, group_ids: getShareGroupIds(merged) };
  }

  it('merges scope groups when creating doc in scoped directory', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1', 'g2'] });
    const scopesMap = makeScopesMap(scope);
    const groups = [makeGroup('g1'), makeGroup('g2')];
    const directory = {
      record_id: 'dir-1',
      scope_id: 'scope-1',
      shares: [{ type: 'group', key: 'group:g1', group_npub: 'g1', access: 'write' }],
    };

    const result = simulateCreateDocShares(directory, scopesMap, groups, () => [
      normalizeDocShare({ type: 'group', group_npub: 'g1', access: 'write' }, 'dir-1'),
    ]);

    expect(result.group_ids).toContain('g1');
    expect(result.group_ids).toContain('g2');
  });

  it('still works for directory with no scope', () => {
    const directory = {
      record_id: 'dir-1',
      scope_id: null,
      shares: [{ type: 'group', key: 'group:g1', group_npub: 'g1', access: 'write' }],
    };

    const result = simulateCreateDocShares(directory, new Map(), [], () => [
      normalizeDocShare({ type: 'group', group_npub: 'g1', access: 'write' }, 'dir-1'),
    ]);

    expect(result.group_ids).toEqual(['g1']);
  });

  it('uses scope groups even when directory has empty shares', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1'] });
    const scopesMap = makeScopesMap(scope);
    const groups = [makeGroup('g1')];
    const directory = {
      record_id: 'dir-1',
      scope_id: 'scope-1',
      shares: [],
    };

    const result = simulateCreateDocShares(directory, scopesMap, groups, () => []);

    expect(result.group_ids).toContain('g1');
    expect(result.shares).toHaveLength(1);
    expect(result.shares[0].group_npub).toBe('g1');
  });
});

// ---------------------------------------------------------------------------
// 5. Simulate createDirectory fix
// ---------------------------------------------------------------------------

describe('createDirectory should inherit scope shares from parent directory', () => {
  function simulateCreateDirectoryShares(parentDirectory, scopesMap, groups, getInheritedShares) {
    const inherited = getInheritedShares(parentDirectory);
    const scopeId = parentDirectory?.scope_id || null;

    if (!scopeId) {
      return { shares: inherited, group_ids: getShareGroupIds(inherited) };
    }

    const scope = scopesMap.get(scopeId);
    if (!scope) {
      return { shares: inherited, group_ids: getShareGroupIds(inherited) };
    }

    const scopeShares = buildScopeShares(normalizeGroupIds(scope.group_ids), groups);
    const merged = mergeDocShareLists(inherited, scopeShares);
    return { shares: merged, group_ids: getShareGroupIds(merged) };
  }

  it('inherits both parent shares and parent scope groups', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g-scope'] });
    const scopesMap = makeScopesMap(scope);
    const parentDirectory = {
      record_id: 'dir-parent',
      scope_id: 'scope-1',
      shares: [{ type: 'group', key: 'group:g-explicit', group_npub: 'g-explicit', access: 'write' }],
    };

    const result = simulateCreateDirectoryShares(parentDirectory, scopesMap, [makeGroup('g-scope')], () => [
      normalizeDocShare({ type: 'group', group_npub: 'g-explicit', access: 'write' }, 'dir-parent'),
    ]);

    expect(result.group_ids).toContain('g-explicit');
    expect(result.group_ids).toContain('g-scope');
  });
});

// ---------------------------------------------------------------------------
// 6. Simulate updateDirectoryScope fix
// ---------------------------------------------------------------------------

describe('updateDirectoryScope should merge scope shares', () => {
  function simulateUpdateDirectoryScopeShares(dir, scopeId, scopesMap, groups) {
    const scope = scopeId ? scopesMap.get(scopeId) : null;
    const existingShares = getStoredDocShares(dir);

    if (!scope) {
      return { shares: existingShares, group_ids: getShareGroupIds(existingShares) };
    }

    const scopeGroupIds = normalizeGroupIds(scope.group_ids);
    const scopeShares = buildScopeShares(scopeGroupIds, groups);
    const merged = mergeDocShareLists(existingShares, scopeShares);
    return { shares: merged, group_ids: getShareGroupIds(merged) };
  }

  it('adds scope groups to directory when scope is assigned', () => {
    const scope = makeScope('scope-1', 'l1', null, { group_ids: ['g1'] });
    const scopesMap = makeScopesMap(scope);
    const dir = { record_id: 'dir-1', shares: [], group_ids: [] };

    const result = simulateUpdateDirectoryScopeShares(dir, 'scope-1', scopesMap, [makeGroup('g1')]);
    expect(result.group_ids).toContain('g1');
    expect(result.shares).toHaveLength(1);
  });

  it('preserves existing shares when scope is cleared', () => {
    const dir = {
      record_id: 'dir-1',
      shares: [{ type: 'group', key: 'group:g1', group_npub: 'g1', access: 'write' }],
      group_ids: ['g1'],
    };

    const result = simulateUpdateDirectoryScopeShares(dir, null, new Map(), []);
    expect(result.group_ids).toEqual(['g1']);
  });
});
