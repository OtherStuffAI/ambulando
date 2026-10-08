// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { getTaskById, openWorkspaceDb, upsertTask } from '../src/db.js';
const { storeMock, updateTask } = vi.hoisted(() => ({ storeMock: vi.fn(), updateTask: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: storeMock, start: vi.fn(), nextTick: callback => callback() } }));
vi.mock('../src/pg-write-adapter.js', async original => ({ ...(await original()), updateTowerPgTaskFromLocal: updateTask }));
afterEach(() => { storeMock.mockClear(); updateTask.mockReset(); });
// jsdom has no layout engine. Native selection geometry is exercised by the
// browser specs; provide the missing Range API for Tiptap's selection observer.
const rangeGeometry = ['getClientRects', 'getBoundingClientRect'];
const originalRangeGeometry = new Map(rangeGeometry.map(key => [key, Object.getOwnPropertyDescriptor(Range.prototype, key)]));
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  for (const [key, descriptor] of originalRangeGeometry) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else delete Range.prototype[key];
  }
});


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
    session: { npub: 'npub1fixture' }, tasks: [task],
    selectPgChannelContext: vi.fn(), startWorkspaceLiveQueries: vi.fn(), recomputeTowerPgUnreadProjection: vi.fn(), loadTaskComments: vi.fn(), markTaskRead: vi.fn(), syncRoute: vi.fn(), resolveChatProfile: vi.fn(),
    ownerNpub: task.owner_npub, currentWorkspaceOwnerNpub: task.owner_npub,
    selectedWorkspaceKey: 'workspace', backendUrl: 'http://127.0.0.1:3100',
    knownWorkspaces: [{ workspaceKey: 'workspace', workspaceId: 'workspace', workspaceOwnerNpub: task.owner_npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }],
    handleEditingTaskDraftChanged: vi.fn(), scheduleStorageImageHydration: vi.fn(),
  });
  updateTask.mockImplementation(async (_store, updated) => ({ ...updated, version: 2, sync_status: 'synced' }));
  const section = document.createElement('div');
  section.className = 'task-description-section';
  const element = document.createElement('div');
  element.className = 'task-rich-editor';
  section.append(element);
  document.body.append(section);
  try {
    store.openTaskDetail(task.record_id);
    await store.applySelectedTask(task);
    expect(store.taskDescriptionEditing).toBe(false);
    store.handleEditingTaskDraftChanged.mockClear();
    expect(await store.editTaskDescription({ type: 'keydown', target: section, currentTarget: section })).toBe(true);
    expect(document.activeElement).toBe(element.querySelector('.ProseMirror'));
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
    await store.setEditingTaskDate('2028-02-29');
    await store.changeEditingTaskTag('POLISH,design,polish');
    await store.saveEditingTask();
    expect(store.error).toBeFalsy();
    expect(updateTask).toHaveBeenCalledTimes(1);
    const saved = await getTaskById(task.record_id);
    expect(saved.scheduled_for).toBe('2028-02-29');
    expect(saved.tags).toBe('polish,design');
    expect(updateTask.mock.calls[0][1].scheduled_for).toBe('2028-02-29');
    expect(updateTask.mock.calls[0][1].tags).toBe('polish,design');
    expect(saved.description).toContain('Revised');
    expect(saved.description).toContain('@[Dependency](mention:task:dependency)');
    expect(saved.description).toContain('https://example.com/guide');
    store.openTaskDetail(task.record_id);
    expect(await store.editTaskDescription({ type: 'keydown', target: section, currentTarget: section })).toBe(true);
    expect(element.querySelector('h1').textContent).toContain('Revised');
    expect(element.querySelector('a[data-mention-id="dependency"]')).not.toBeNull();
    expect(element.querySelector('li').textContent).toBe('A useful list');
    await store.setEditingTaskDate(null);
    await store.changeEditingTaskTag('polish', true);
    await store.changeEditingTaskTag('design', true);
    await store.saveEditingTask();
    const cleared = await getTaskById(task.record_id);
    expect(cleared.scheduled_for).toBeNull();
    expect(cleared.tags).toBe('');
    expect(updateTask.mock.calls[1][3]).toMatchObject({ scheduled_for: null, tags: '' });
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
  } finally { store.destroyTaskRichDescriptionEditor(); section.remove(); }
});

it('opens an empty task, types a description, saves and reopens it, and honours failed edit entry', async () => {
  const db = openWorkspaceDb('npub1empty-task-workspace');
  await db.open();
  await Promise.all(db.tables.map(table => table.clear()));
  const task = { record_id: 'empty-task', title: 'Empty brief', description: '', state: 'in_progress', priority: 'sand', version: 1, record_state: 'active', sync_status: 'synced', pg_backend: true, pg_record_type: 'task', pg_channel_id: 'channel', owner_npub: 'npub1empty-task-workspace' };
  await upsertTask(task);
  const { initApp } = await import('../src/app.js');
  initApp();
  const store = storeMock.mock.calls.find(([name]) => name === 'chat')[1];
  Object.assign(store, {
    session: { npub: 'npub1fixture' }, tasks: [task],
    selectPgChannelContext: vi.fn(), startWorkspaceLiveQueries: vi.fn(), recomputeTowerPgUnreadProjection: vi.fn(),
    loadTaskComments: vi.fn(), markTaskRead: vi.fn(), syncRoute: vi.fn(), resolveChatProfile: vi.fn(), scheduleStorageImageHydration: vi.fn(),
    ownerNpub: task.owner_npub, currentWorkspaceOwnerNpub: task.owner_npub,
    selectedWorkspaceKey: 'workspace', backendUrl: 'http://127.0.0.1:3100',
    knownWorkspaces: [{ workspaceKey: 'workspace', workspaceId: 'workspace', workspaceOwnerNpub: task.owner_npub, directHttpsUrl: 'http://127.0.0.1:3100', appNpub: 'flightdeck_pg', pgBackendMode: true }],
  });
  updateTask.mockImplementation(async (_store, updated) => ({ ...updated, version: 2, sync_status: 'synced' }));
  const section = document.createElement('div');
  section.className = 'task-description-section';
  const element = document.createElement('div'); element.className = 'task-rich-editor';
  section.append(element); document.body.append(section);
  const event = { type: 'keydown', target: section, currentTarget: section };
  try {
    store.openTaskDetail(task.record_id);
    await store.applySelectedTask(task);
    expect(await store.editTaskDescription(event)).toBe(true);
    expect(store.taskDraftDirty).toBe(false);
    store.taskRichDescriptionAdapter.getEditor().commands.insertContent('First empty task character');
    expect(store.taskDraftDirty).toBe(true);
    await store.saveEditingTask();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect((await getTaskById(task.record_id)).description).toBe('First empty task character');
    store.openTaskDetail(task.record_id);
    expect(await store.editTaskDescription(event)).toBe(true);
    expect(element.querySelector('.ProseMirror').textContent).toBe('First empty task character');
    store.openTaskDetail(task.record_id);
    store.session = null;
    expect(await store.editTaskDescription(event)).toBe(false);
    store.session = { npub: 'npub1fixture' };
    // A view-only entry must go through the existing edit/checkout operation.
    store.taskDetailMode = 'view';
    store.enterTaskDetailEditMode = vi.fn(async () => false);
    expect(await store.editTaskDescription(event)).toBe(false);
    expect(store.enterTaskDetailEditMode).toHaveBeenCalledTimes(1);
    expect(store.taskDescriptionEditing).toBe(false);
    expect(store.taskRichDescriptionAdapter).toBeNull();
  } finally { store.destroyTaskRichDescriptionEditor(); section.remove(); await store.clearTaskLocalDraft(task.record_id); }
});

it('ignores an unmounted task editor before starting an editor operation', async () => {
  const { initApp } = await import('../src/app.js');
  initApp();
  const store = storeMock.mock.calls.find(([name]) => name === 'chat')[1];
  await expect(store.mountTaskRichDescriptionEditor(null)).resolves.toBe(false);
});
