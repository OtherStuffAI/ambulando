import { describe, expect, it, vi } from 'vitest';
import { taskBoardStateMixin } from '../src/task-board-state.js';

describe('record link UI/context helpers', () => {
  it('returns no visible sections for null records during navigation teardown', () => {
    expect(taskBoardStateMixin.getVisibleRecordLinkSections.call({}, null)).toEqual([]);
  });

  it('surfaces source and deliverables ahead of generic references', () => {
    const sections = taskBoardStateMixin.getVisibleRecordLinkSections.call({}, {
      source_links: [{ type: 'task', id: 'task-source' }],
      references: [{ type: 'scope', id: 'scope-ref' }, { type: 'task', id: 'task-source' }],
      deliverable_links: [{ type: 'doc', id: 'doc-out', order: 1 }],
    });

    expect(sections.map((section) => section.kind)).toEqual(['source', 'deliverable', 'reference']);
    expect(sections[0].links[0].id).toBe('task-source');
    expect(sections[1].links[0].id).toBe('doc-out');
    expect(sections[2].links).toEqual([{ type: 'scope', id: 'scope-ref' }]);
  });

  it('derives subtask deliverables from reverse source links', () => {
    const parent = { record_id: 'task-parent', title: 'Parent task' };
    const store = {
      tasks: [
        parent,
        {
          record_id: 'task-child',
          title: 'Child task',
          source_links: [{ type: 'task', id: 'task-parent' }],
          record_state: 'active',
        },
      ],
    };

    const sections = taskBoardStateMixin.getVisibleRecordLinkSections.call(store, parent);

    expect(sections).toEqual([{
      kind: 'deliverable',
      label: 'Deliverables',
      links: [{ type: 'task', id: 'task-child' }],
    }]);
  });

  it('derives opportunity-created task deliverables from reverse source links', () => {
    const opportunity = { record_id: 'opp-1', title: 'Acme opportunity' };
    const store = {
      opportunities: [opportunity],
      tasks: [{
        record_id: 'task-from-opp',
        title: 'Follow up',
        source_links: [{ type: 'opportunity', id: 'opp-1' }],
        record_state: 'active',
      }],
    };

    const sections = taskBoardStateMixin.getVisibleRecordLinkSections.call(store, opportunity);

    expect(sections).toEqual([{
      kind: 'deliverable',
      label: 'Deliverables',
      links: [{ type: 'task', id: 'task-from-opp' }],
    }]);
  });

  it('routes visible record links through mention navigation', async () => {
    const store = {
      handleMentionNavigate: vi.fn(),
    };

    await taskBoardStateMixin.navigateReference.call(store, { type: 'document', id: 'doc-1' });

    expect(store.handleMentionNavigate).toHaveBeenCalledWith('doc', 'doc-1');
  });

  it('resolves document aliases consistently for labels and navigability', () => {
    const store = {
      documents: [{ record_id: 'doc-1', title: 'Strategy memo' }],
    };

    expect(taskBoardStateMixin.resolveReferenceLabel.call(store, { type: 'document', id: 'doc-1' }))
      .toBe('Strategy memo');
    expect(taskBoardStateMixin.getRecordLinkTypeLabel.call(store, { type: 'documents', id: 'doc-1' }))
      .toBe('Doc');
    expect(taskBoardStateMixin.isNavigableRecordLink.call(store, { type: 'document', id: 'doc-1' }))
      .toBe(true);
  });

  it('hides unsupported link types so chips are not dead clicks', () => {
    const sections = taskBoardStateMixin.getVisibleRecordLinkSections.call({}, {
      references: [
        { type: 'task', id: 'task-1' },
        { type: 'schedule', id: 'schedule-1' },
      ],
    });

    expect(sections).toEqual([{
      kind: 'reference',
      label: 'References',
      links: [{ type: 'task', id: 'task-1' }],
    }]);
  });

  it.each([
    ['directory', 'folder-1', 'directory'],
    ['report', 'report-1', 'report'],
    ['message', 'uncached-message', 'chat'],
    ['thread', 'uncached-thread', 'chat'],
    ['chat', 'channel-1#root-1', 'chat'],
    ['channel', 'uncached-channel', 'channel'],
  ])('routes %s references through the target resolver without requiring rendered rows', async (type, id, normalizedType) => {
    const store = { handleMentionNavigate: vi.fn().mockResolvedValue(true), messages: [] };
    expect(await taskBoardStateMixin.navigateReference.call(store, { type, id })).toBe(true);
    expect(store.handleMentionNavigate).toHaveBeenCalledWith(normalizedType, id);
  });

  it('awaits the resolver so failures remain observable by the click surface', async () => {
    const failure = new Error('Target unavailable');
    const store = { handleMentionNavigate: vi.fn().mockRejectedValue(failure) };
    await expect(taskBoardStateMixin.navigateReference.call(store, { type: 'report', id: 'missing' })).rejects.toBe(failure);
  });
});
