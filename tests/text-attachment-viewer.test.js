// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  completeStorageObject: vi.fn(async () => ({})),
  createTowerPgChannelFile: vi.fn(),
  createTowerPgFileVersion: vi.fn(),
  downloadStorageObjectBlob: vi.fn(),
  getTowerPgChannelFiles: vi.fn(async () => ({ files: [] })),
  getTowerPgFileVersionObjectBytes: vi.fn(),
  getTowerPgFileVersions: vi.fn(async () => ({ versions: [] })),
  uploadStorageObject: vi.fn(async () => ({})),
}));
vi.mock('../src/api.js', () => api);
vi.mock('../src/db.js', () => ({
  getTextAttachmentCache: vi.fn(async () => null),
  putTextAttachmentCache: vi.fn(async () => null),
  putTextAttachmentDraft: vi.fn(async () => null),
}));

import { textAttachmentViewerMixin } from '../src/text-attachment-viewer.js';

const enc = (text) => new TextEncoder().encode(text);
const message = { record_id: 'msg-1', channel_id: 'chan-1' };
const attachment = { storage_object_id: 'obj-orig', filename: 'Pasted text.txt', content_type: 'text/plain; charset=utf-8', size_bytes: 6, text_attachment: { v: 1, source: 'paste', chars: 6, lines: 2 } };

function makeStore() {
  const store = {};
  Object.defineProperties(store, Object.getOwnPropertyDescriptors(textAttachmentViewerMixin));
  store.textAttachmentModal = { ...store.textAttachmentModal };
  Object.assign(store, {
    canComposeInChatDestination: true,
    workspaceOwnerNpub: 'npub-owner',
    session: { npub: 'npub-me' },
    captureStorageUploadContext: () => ({ workspaceId: 'ws-1', pg: true, options: { baseUrl: 'http://tower' }, assertCurrent() {} }),
    prepareStorageObjectForCurrentWorkspace: vi.fn(async () => ({ object_id: `new-${store._n = (store._n || 0) + 1}` })),
  });
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTowerPgChannelFiles.mockResolvedValue({ files: [] });
  api.getTowerPgFileVersions.mockResolvedValue({ versions: [] });
  api.downloadStorageObjectBlob.mockResolvedValue(new Blob([enc('one\r\ntwo')]));
});

describe('sent text attachment viewer', () => {
  it('opens the pinned original read-only and downloads exact text', async () => {
    const store = makeStore();
    await store.openSentTextAttachment(message, attachment);
    const modal = store.textAttachmentModal;
    expect(modal).toMatchObject({ status: 'ready', viewing: 'original', editing: false });
    expect(modal.pages.join('')).toBe('one\r\ntwo');
    expect(modal.versions.map((v) => v.label)).toEqual(['Original (sent)']);
  });

  it('first edit creates the lineage file with the origin ids and keeps CRLF in untouched text', async () => {
    const store = makeStore();
    api.createTowerPgChannelFile.mockResolvedValue({ file: { id: 'file-1', current_version_id: 'ver-1' } });
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'ver-1', version_number: 1 }] });
    await store.openSentTextAttachment(message, attachment);
    store.startTextAttachmentEdit();
    store.textAttachmentModal.pageValue = 'one\ntwo!';
    store.textModalMarkDirty();
    await store.saveSentTextAttachment();
    const body = api.createTowerPgChannelFile.mock.calls[0][2];
    expect(api.createTowerPgChannelFile.mock.calls[0][1]).toBe('chan-1');
    expect(body.metadata.text_attachment_lineage).toEqual({ v: 1, origin_message_id: 'msg-1', origin_storage_object_id: 'obj-orig', origin_filename: 'Pasted text.txt' });
    expect(api.uploadStorageObject.mock.calls[0][1]).toEqual(enc('one\r\ntwo!'));
    expect(store.textAttachmentModal.saveState).toBe('Saved as new version');
    expect(store.textAttachmentModal.versions.map((v) => v.label)).toEqual(['Version 1 (latest)', 'Original (sent)']);
  });

  it('later edits post a version on the current base and keep the original available', async () => {
    const store = makeStore();
    const lineageFile = { id: 'file-1', current_version_id: 'ver-1', metadata: { text_attachment_lineage: { origin_message_id: 'msg-1', origin_storage_object_id: 'obj-orig' } } };
    api.getTowerPgChannelFiles.mockResolvedValue({ files: [lineageFile] });
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'ver-1', version_number: 1 }] });
    api.getTowerPgFileVersionObjectBytes.mockResolvedValue({ bytes: enc('v1 text').buffer });
    await store.openSentTextAttachment(message, attachment);
    expect(store.textAttachmentModal.viewing).toBe('ver-1');
    api.createTowerPgFileVersion.mockResolvedValue({ version: { id: 'ver-2' }, file: { id: 'file-1', current_version_id: 'ver-2' } });
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [{ id: 'ver-1', version_number: 1 }, { id: 'ver-2', version_number: 2 }] });
    store.startTextAttachmentEdit();
    store.textAttachmentModal.pageValue = 'v2 text';
    store.textModalMarkDirty();
    await store.saveSentTextAttachment();
    expect(api.createTowerPgFileVersion.mock.calls[0][2]).toMatchObject({ base_version_id: 'ver-1' });
    expect(store.textAttachmentModal.versions.map((v) => v.id)).toEqual(['ver-2', 'ver-1', 'original']);
  });

  it('keeps the local edit when a concurrent first edit wins, then rebases explicitly', async () => {
    const store = makeStore();
    await store.openSentTextAttachment(message, attachment);
    store.startTextAttachmentEdit();
    store.textAttachmentModal.pageValue = 'mine';
    store.textModalMarkDirty();
    const canonical = { id: 'file-9', current_version_id: 'ver-9' };
    api.createTowerPgChannelFile.mockRejectedValue(Object.assign(new Error('409'), { status: 409, code: 'lineage_file_exists', payload: { file: canonical, current_version: { id: 'ver-9' } } }));
    api.getTowerPgFileVersionObjectBytes.mockResolvedValue({ bytes: enc('theirs').buffer });
    await store.saveSentTextAttachment();
    const conflict = store.textAttachmentModal.conflict;
    expect(conflict).toMatchObject({ mine: 'mine', theirs: 'theirs', upload: { objectId: 'new-1' } });
    expect(api.createTowerPgFileVersion).not.toHaveBeenCalled();
    api.createTowerPgFileVersion.mockResolvedValue({ version: { id: 'ver-10' }, file: { id: 'file-9' } });
    api.getTowerPgFileVersions.mockResolvedValue({ versions: [] });
    await store.resolveTextAttachmentConflict('keep-mine');
    expect(api.createTowerPgFileVersion.mock.calls[0][2]).toMatchObject({ base_version_id: 'ver-9', storage_object_id: 'new-1' });
    expect(store.prepareStorageObjectForCurrentWorkspace).toHaveBeenCalledTimes(1);
  });

  it('reports a permission failure without losing the text', async () => {
    const store = makeStore();
    await store.openSentTextAttachment(message, attachment);
    store.startTextAttachmentEdit();
    store.textAttachmentModal.pageValue = 'denied edit';
    store.textModalMarkDirty();
    api.createTowerPgChannelFile.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await store.saveSentTextAttachment();
    expect(store.textAttachmentModal.error).toMatch(/permission/);
    expect(store.textAttachmentModal.editing).toBe(true);
    expect(store.textModalFullText()).toBe('denied edit');
  });

  it('refuses to edit non-UTF-8 content', async () => {
    const store = makeStore();
    api.downloadStorageObjectBlob.mockResolvedValue(new Blob([new Uint8Array([0xff, 0xfe, 0xfd])]));
    await store.openSentTextAttachment(message, attachment);
    expect(store.textAttachmentModal.status).toBe('error');
    expect(store.textAttachmentModal.error).toMatch(/UTF-8/);
  });
});

describe('draft text attachment editor', () => {
  function draftStore(text) {
    const store = makeStore();
    const file = new File([enc(text)], 'Pasted text.txt', { type: 'text/plain; charset=utf-8' });
    let drafts = [{ draft_id: 'd1', file, filename: 'Pasted text.txt', status: 'ready', storage_object_id: 'old', text_attachment: { v: 1, source: 'paste' } }];
    store.getChatFileDrafts = () => drafts;
    store.setChatFileDrafts = (_context, next) => { drafts = next; };
    store.uploadChatFileDraft = vi.fn();
    return { store, get: () => drafts[0] };
  }

  it('edits, renames and re-queues the upload with exact CRLF bytes; cancel changes nothing', async () => {
    const { store, get } = draftStore('a\r\nb\r\n');
    await store.openTextAttachmentDraft('d1', 'message');
    expect(store.textAttachmentModal.status).toBe('ready');
    store.textAttachmentModal.filename = 'notes';
    store.textAttachmentModal.pageValue = 'a\nb\nc\n';
    store.textModalMarkDirty();
    store.cancelTextAttachmentEdit();
    expect(get().filename).toBe('Pasted text.txt');

    await store.openTextAttachmentDraft('d1', 'message');
    store.textAttachmentModal.filename = 'notes';
    store.textAttachmentModal.pageValue = 'a\nb\nc\n';
    store.textModalMarkDirty();
    await store.saveTextAttachmentDraft();
    const draft = get();
    expect(draft).toMatchObject({ filename: 'notes.txt', status: 'uploading', storage_object_id: undefined, text_attachment: { chars: 9, lines: 4 } });
    expect(Array.from(new Uint8Array(await draft.file.arrayBuffer()))).toEqual(Array.from(enc('a\r\nb\r\nc\r\n')));
    expect(store.uploadChatFileDraft).toHaveBeenCalledWith('d1', 'message');
    expect(store.textAttachmentModal.open).toBe(false);
  });

  it('does not re-upload when nothing changed', async () => {
    const { store } = draftStore('same');
    await store.openTextAttachmentDraft('d1', 'message');
    await store.saveTextAttachmentDraft();
    expect(store.uploadChatFileDraft).not.toHaveBeenCalled();
  });
});

describe('large content regression', () => {
  it('opens a 3.94MB log in bounded pages and saves untouched pages byte-exact', async () => {
    const store = makeStore();
    const line = '2026-10-26T10:00:00Z INFO worker-7 processed batch 12345 ok\r\n';
    const log = line.repeat(Math.ceil(3_940_000 / line.length));
    api.downloadStorageObjectBlob.mockResolvedValue(new Blob([enc(log)]));
    const started = performance.now();
    await store.openSentTextAttachment(message, attachment);
    const modal = store.textAttachmentModal;
    expect(modal.status).toBe('ready');
    expect(modal.pageValue.length).toBeLessThanOrEqual(16000);
    expect(modal.pages.length).toBeGreaterThan(200);
    expect(modal.totals.bytes).toBe(enc(log).byteLength);
    expect(performance.now() - started).toBeLessThan(3000);
    store.startTextAttachmentEdit();
    store.textModalGoToPage(5);
    store.textAttachmentModal.pageValue += 'tail';
    store.textModalMarkDirty();
    expect(store.textModalFullText().length).toBe(log.length + 4);
    expect(store.textModalFullText().startsWith(log.slice(0, 1000))).toBe(true);
  });

  it('pages a pathological single line of astral characters without splitting pairs', async () => {
    const store = makeStore();
    const text = '😀'.repeat(300_000);
    api.downloadStorageObjectBlob.mockResolvedValue(new Blob([enc(text)]));
    await store.openSentTextAttachment(message, attachment);
    expect(store.textAttachmentModal.status).toBe('ready');
    expect(store.textAttachmentModal.pageValue.length).toBeLessThanOrEqual(16000);
    expect(store.textModalFullText()).toBe(text);
  });
});
