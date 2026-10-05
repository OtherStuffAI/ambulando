// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { getTaskById, openWorkspaceDb, upsertTask } from '../src/db.js';
const { storeMock, updateTask } = vi.hoisted(() => ({ storeMock: vi.fn(), updateTask: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: storeMock, start: vi.fn() } }));
vi.mock('../src/pg-write-adapter.js', async original => ({ ...(await original()), updateTowerPgTaskFromLocal: updateTask }));
afterEach(() => { storeMock.mockClear(); updateTask.mockReset(); });

it('saves a native Tiptap task edit through the PG path and reopens Markdown references intact', async () => {
  const db = openWorkspaceDb('npub1rich-task-workspace');
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  const task = { record_id: 'rich-task', title: 'Rich description', description: '# Outcome\n\n[Guide](https://example.com/guide), @[Dependency](mention:task:dependency) and @[Reviewer](mention:person:npub1fixture).\n\n- A useful list', state: 'in_progress', priority: 'sand', scope_id: 'scope', version: 1, record_state: 'active', sync_status: 'synced', pg_backend: true, pg_record_type: 'task', pg_channel_id: 'channel', owner_npub: 'npub1rich-task-workspace' };
  await upsertTask(task);
  const { initApp } = await import('../src/app.js');
  initApp();
  const store = storeMock.mock.calls.find(([name]) => name === 'chat')[1];
  Object.assign(store, {
    session: { npub: 'npub1fixture' }, tasks: [task], editingTask: { ...task }, taskEditOriginal: { ...task }, activeTaskId: task.record_id,
    taskDetailMode: 'edit', taskDescriptionEditing: true,
    ownerNpub: task.owner_npub, currentWorkspaceOwnerNpub: task.owner_npub,
    selectedWorkspaceKey: 'workspace', backendUrl: 'http://127.0.0.1:3100',
    knownWorkspaces: [{ workspaceKey: 'workspace', workspaceId: 'workspace', workspaceOwnerNpub: task.owner_npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }],
    handleEditingTaskDraftChanged: vi.fn(), scheduleStorageImageHydration: vi.fn(),
  });
  updateTask.mockImplementation(async (_store, updated) => ({ ...updated, version: 2, sync_status: 'synced' }));
  const element = document.createElement('div');
  document.body.append(element);
  try {
    await Promise.all([store.mountTaskRichDescriptionEditor(element), store.mountTaskRichDescriptionEditor(element)]);
    expect(element.querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(element.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(store.handleEditingTaskDraftChanged).not.toHaveBeenCalled();
    store.taskRichDescriptionAdapter.getEditor().commands.setTextSelection(2);
    store.taskRichDescriptionAdapter.getEditor().commands.insertContent('Revised ');
    expect(store.editingTask.description).toContain('Revised');
    expect(store.handleEditingTaskDraftChanged).toHaveBeenCalled();
    let finishUpload;
    store.uploadInlineImageFile = vi.fn(() => new Promise(resolve => { finishUpload = resolve; }));
    const imagePaste = { clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['image'], 'test.png', { type: 'image/png' }) }] }, preventDefault: vi.fn() };
    expect(store.handleTaskRichPaste(imagePaste, store.taskRichDescriptionAdapter.getEditor())).toBe(true);
    await store.saveEditingTask();
    expect(store.error).toBe('Wait for image upload to finish.');
    expect(updateTask).not.toHaveBeenCalled();
    finishUpload({ objectId: 'pasted-image', fileName: 'test.png' });
    await vi.waitFor(() => expect(store.taskRichDescriptionUploadIds).toHaveLength(0));
    expect(store.editingTask.description).toContain('storage://pasted-image');
    store.error = null;
    await store.saveEditingTask();
    expect(store.error).toBeFalsy();
    expect(updateTask).toHaveBeenCalledTimes(1);
    const saved = await getTaskById(task.record_id);
    expect(saved.description).toContain('Revised');
    expect(saved.description).toContain('@[Dependency](mention:task:dependency)');
    expect(saved.description).toContain('https://example.com/guide');
    await store.mountTaskRichDescriptionEditor(element);
    expect(element.querySelector('h1').textContent).toContain('Revised');
    expect(element.querySelector('a[data-mention-id="dependency"]')).not.toBeNull();
    expect(element.querySelector('li').textContent).toBe('A useful list');
    store.editingTask.description = '## External refresh\n\n@[Dependency](mention:task:dependency)';
    await store.mountTaskRichDescriptionEditor(element);
    expect(element.querySelector('h2').textContent).toBe('External refresh');
    expect(element.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    store.handleTaskRichPaste(imagePaste, store.taskRichDescriptionAdapter.getEditor());
    store.destroyTaskRichDescriptionEditor();
    store.editingTask = { record_id: 'other-task', description: 'Preserve the other task' };
    finishUpload({ objectId: 'late-image', fileName: 'late.png' });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.editingTask.description).toBe('Preserve the other task');
    expect(element.querySelector('[role="toolbar"]')).toBeNull();
    expect(store.taskRichDescriptionAdapter).toBeNull();
  } finally { store.destroyTaskRichDescriptionEditor(); element.remove(); }
});
