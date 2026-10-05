// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hydrateMentionComposer, serializeMentionComposer } from '../src/mention-composer.js';
import { renderMarkdownToHtml } from '../src/markdown.js';
import { storageAttachmentsFromMarkdown } from '../src/chat-attachments.js';

const { alpineStartMock, alpineStoreMock, alpineNextTickMock } = vi.hoisted(() => ({
  alpineNextTickMock: vi.fn(callback => callback?.()),
  alpineStartMock: vi.fn(),
  alpineStoreMock: vi.fn(),
}));
const NativeURL = globalThis.URL;

vi.mock('alpinejs', () => ({
  default: { store: alpineStoreMock, start: alpineStartMock, nextTick: alpineNextTickMock },
}));

async function createStore() {
  vi.resetModules();
  const { initApp } = await import('../src/app.js');
  initApp();
  const store = alpineStoreMock.mock.calls.find(([name]) => name === 'chat')?.[1];
  store.uploadChatFileDraft = vi.fn();
  store.$nextTick = (callback) => callback?.();
  return store;
}

beforeEach(() => {
  alpineStartMock.mockClear();
  alpineStoreMock.mockClear();
  document.body.replaceChildren();
  NativeURL.createObjectURL = vi.fn((file) => `blob:${file.name}`);
  NativeURL.revokeObjectURL = vi.fn();
});

function composerAt(value, offset) {
  const target = document.createElement('div');
  target.setAttribute('contenteditable', 'true');
  target.dataset.chatComposer = 'message';
  hydrateMentionComposer(target, value);
  document.body.append(target);
  const range = document.createRange();
  range.setStart(target.firstChild || target, offset);
  range.collapse(true);
  target.focus();
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return target;
}

describe('chat composer image previews', () => {
  it('replaces the paste-position upload token with the exact storage reference and retains the thumbnail draft', async () => {
    const store = await createStore();
    const target = composerAt('before after', 6);
    const image = new File(['image'], 'pasted.png', { type: 'image/png' });
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    store.uploadChatFileDraft = vi.fn((draftId, context) => {
      store.setChatFileDrafts(context, store.getChatFileDrafts(context).map((draft) => (
        draft.draft_id === draftId
          ? { ...draft, storage_object_id: 'image-object-1', status: 'ready' }
          : draft
      )));
      store.resolveChatFileDraftInlineToken(
        draftId,
        context,
        store.createStorageMarkdown('image-object-1', 'pasted.png'),
      );
    });

    await store.handleMentionComposerPaste({
      currentTarget: target,
      preventDefault: vi.fn(),
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] },
    }, 'message');

    expect(serializeMentionComposer(target)).toBe('before![pasted.png](storage://image-object-1) after');
    expect(store.messageInput).toBe('before![pasted.png](storage://image-object-1) after');
    expect(store.messageFileDrafts).toHaveLength(1);
    expect(store.messageFileDrafts[0]).toMatchObject({
      filename: 'pasted.png',
      kind: 'image',
      storage_object_id: 'image-object-1',
      preview_url: 'blob:pasted.png',
    });
    expect(renderMarkdownToHtml(store.messageInput)).toContain('data-storage-object-id="image-object-1"');
    expect(storageAttachmentsFromMarkdown(store.messageInput)).toEqual([
      { kind: 'image', storage_object_id: 'image-object-1', filename: 'pasted.png' },
    ]);
  });

  it('preserves multiple image positions and order when uploads finish out of order', async () => {
    const store = await createStore();
    const target = composerAt('before after', 6);
    const first = new File(['one'], 'one.png', { type: 'image/png' });
    const second = new File(['two'], 'two.jpg', { type: 'image/jpeg' });
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    const uploads = [];
    store.uploadChatFileDraft = vi.fn((draftId, context) => uploads.push({ draftId, context }));

    await store.handleMentionComposerPaste({
      currentTarget: target,
      preventDefault: vi.fn(),
      clipboardData: {
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => first },
          { kind: 'file', type: 'image/jpeg', getAsFile: () => second },
        ],
      },
    }, 'message');

    store.messageInput = store.messageInput.replace(' after', ' typed while uploading after');
    hydrateMentionComposer(target, store.messageInput);

    const resolveUpload = (upload, objectId) => {
      const draft = store.getChatFileDrafts(upload.context).find((item) => item.draft_id === upload.draftId);
      store.setChatFileDrafts(upload.context, store.getChatFileDrafts(upload.context).map((item) => (
        item.draft_id === upload.draftId ? { ...item, storage_object_id: objectId, status: 'ready' } : item
      )));
      store.resolveChatFileDraftInlineToken(
        upload.draftId,
        upload.context,
        store.createStorageMarkdown(objectId, draft.filename),
      );
    };
    resolveUpload(uploads[1], 'image-two');
    resolveUpload(uploads[0], 'image-one');

    expect(store.messageInput).toBe(
      'before![one.png](storage://image-one)![two.jpg](storage://image-two) typed while uploading after',
    );
    expect(store.messageFileDrafts.map((draft) => draft.filename)).toEqual(['one.png', 'two.jpg']);
    expect(storageAttachmentsFromMarkdown(store.messageInput).map((attachment) => attachment.storage_object_id))
      .toEqual(['image-one', 'image-two']);
  });

  it('removes a pending inline token with its thumbnail and ignores its later upload completion', async () => {
    const store = await createStore();
    const target = composerAt('', 0);
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    store.uploadChatFileDraft = vi.fn();
    await store.handleMentionComposerPaste({
      currentTarget: target,
      preventDefault: vi.fn(),
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['image'], 'one.png', { type: 'image/png' }) }],
      },
    }, 'message');
    const [removed] = store.messageFileDrafts;
    expect(store.messageInput).toContain('Uploading image');
    store.removeChatFileDraft(removed.draft_id, 'message');

    expect(store.messageInput).toBe('');
    expect(store.messageFileDrafts).toEqual([]);
    expect(store.resolveChatFileDraftInlineToken(
      removed.draft_id,
      'message',
      '![one.png](storage://late-object)',
    )).toBe(false);
    expect(store.messageInput).toBe('');
  });

  it('routes an immediate Deck thread image paste through the opened message channel', async () => {
    const store = await createStore();
    const image = new File(['image'], 'pasted.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    store.navSection = 'status';
    store.activeThreadId = 'root-1';
    store.deckThreadChannelId = 'channel-opened';
    store.selectedChannelId = 'deck-channel';
    store.channels = [
      { record_id: 'deck-channel', title: 'Deck' },
      { record_id: 'channel-opened', title: 'Opened message channel' },
    ];

    await store.handleMentionComposerPaste({
      preventDefault,
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] },
    }, 'thread');

    expect(store.activeThreadChannel.record_id).toBe('channel-opened');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(store.threadFileDrafts).toHaveLength(1);
    expect(store.threadFileDrafts[0]).toMatchObject({ filename: 'pasted.png', kind: 'image' });
    expect(store.threadInput).toContain('Uploading image');
  });

  it('blocks attachment clipboard content while the opened thread channel is unavailable', async () => {
    const store = await createStore();
    const preventDefault = vi.fn();
    store.navSection = 'status';
    store.activeThreadId = 'root-1';
    store.deckThreadChannelId = 'channel-loading';
    store.selectedChannelId = 'deck-channel';
    store.channels = [{ record_id: 'deck-channel', title: 'Deck' }];

    await store.handleMentionComposerPaste({
      preventDefault,
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['image'], 'pasted.png', { type: 'image/png' }) }],
      },
    }, 'thread');

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(store.threadFileDrafts).toEqual([]);
    expect(store.threadInput).toBe('');
    expect(store.error).toContain('Thread channel is still loading');
    expect(store.canComposeInThreadDestination).toBe(false);
  });

  it('leaves ordinary text clipboard content on the plain-text paste path', async () => {
    const store = await createStore();
    const preventDefault = vi.fn();

    await expect(store.handleChatPaste({
      preventDefault,
      clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    }, 'thread')).resolves.toBe(false);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it.each(['message', 'thread'])('keeps a large Markdown paste on the %s attachment path', async (context) => {
    const store = await createStore();
    const markdown = new File(
      [new Uint8Array(153_922)],
      'mate-architecture-brief-2026-08-17.md',
      { type: 'text/plain' },
    );
    const preventDefault = vi.fn();
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];

    await store.handleMentionComposerPaste({
      preventDefault,
      clipboardData: {
        items: [{ kind: 'file', type: 'text/plain', getAsFile: () => markdown }],
      },
    }, context);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(store.getChatFileDrafts(context)).toHaveLength(1);
    expect(store.getChatFileDrafts(context)[0]).toMatchObject({
      kind: 'file',
      filename: 'mate-architecture-brief-2026-08-17.md',
      size_bytes: markdown.size,
      status: 'uploading',
    });
    expect(store.uploadChatFileDraft).toHaveBeenCalledOnce();
  });

  it.each(['message', 'thread'])('keeps a large Markdown drop on the %s attachment path', async (context) => {
    const store = await createStore();
    const markdown = new File(
      [new Uint8Array(153_922)],
      'mate-architecture-brief-2026-08-17.md',
      { type: 'text/plain' },
    );
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    store.uploadFileIntoModel = vi.fn();

    await store.handleChatFileDrop({
      preventDefault,
      stopPropagation,
      dataTransfer: { files: [markdown] },
    }, context);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(store.getChatFileDrafts(context)).toHaveLength(1);
    expect(store.getChatFileDrafts(context)[0]).toMatchObject({
      kind: 'file',
      filename: 'mate-architecture-brief-2026-08-17.md',
      size_bytes: markdown.size,
      status: 'uploading',
    });
    expect(store.uploadChatFileDraft).toHaveBeenCalledOnce();
    expect(store.uploadFileIntoModel).not.toHaveBeenCalled();
  });

  it.each(['message', 'thread'])('creates multiple image previews in the %s composer', async (context) => {
    const store = await createStore();
    store.addChatFileDraft(new File(['one'], 'one.png', { type: 'image/png' }), context);
    store.addChatFileDraft(new File(['two'], 'two.jpg', { type: 'image/jpeg' }), context);

    const drafts = store.getChatFileDrafts(context);
    expect(drafts.map((draft) => draft.preview_url)).toEqual(['blob:one.png', 'blob:two.jpg']);
    expect(drafts.every((draft) => draft.kind === 'image')).toBe(true);
  });

  it('opens and closes the modal, restoring focus to its thumbnail', async () => {
    const store = await createStore();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const focus = vi.spyOn(trigger, 'focus');

    store.openChatImagePreview({ preview_url: 'blob:screen.png', filename: 'screen.png' }, trigger);
    expect(store.chatImagePreviewModal).toEqual({ open: true, src: 'blob:screen.png', alt: 'screen.png' });
    store.closeChatImagePreview();

    expect(store.chatImagePreviewModal.open).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('uses Alpine nextTick when the store has no injected nextTick helper', async () => {
    const store = await createStore();
    delete store.$nextTick;
    const close = document.createElement('button');
    close.dataset.chatImagePreviewClose = '';
    const trigger = document.createElement('button');
    document.body.append(close, trigger);
    store.openChatImagePreview({ preview_url: 'blob:preview', filename: 'preview.png' }, trigger);
    expect(document.activeElement).toBe(close);
    store.closeChatImagePreview();
    expect(document.activeElement).toBe(trigger);
    expect(alpineNextTickMock).toHaveBeenCalled();
  });

  it('revokes loaded file image URLs and invalidates pending loads when closing', async () => {
    const store = await createStore();
    store.chatImagePreviewModal = { open: true, src: 'blob:loaded-file', ownedUrl: true };
    store.filePreviewBlob = new Blob(['image']);
    store.filePreviewRequestId = 10;
    store.closeChatImagePreview();
    expect(NativeURL.revokeObjectURL).toHaveBeenCalledWith('blob:loaded-file');
    expect(store.filePreviewRequestId).toBe(11);
    expect(store.filePreviewBlob).toBeNull();
  });

  it('removes one image without disturbing siblings and revokes its object URL', async () => {
    const store = await createStore();
    store.addChatFileDraft(new File(['one'], 'one.png', { type: 'image/png' }), 'message');
    store.addChatFileDraft(new File(['two'], 'two.png', { type: 'image/png' }), 'message');
    const [removed] = store.messageFileDrafts;

    store.removeChatFileDraft(removed.draft_id, 'message');

    expect(store.messageFileDrafts.map((draft) => draft.filename)).toEqual(['two.png']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:one.png');
  });

  it('cleans both composer preview sets during teardown', async () => {
    const store = await createStore();
    store.addChatFileDraft(new File(['one'], 'one.png', { type: 'image/png' }), 'message');
    store.addChatFileDraft(new File(['two'], 'two.png', { type: 'image/png' }), 'thread');

    store.cleanupChatImagePreviews();

    expect(store.messageFileDrafts).toEqual([]);
    expect(store.threadFileDrafts).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('renders the modal thumbnail strip, removal controls, and shared lightbox', () => {
    const html = readFileSync(`${process.cwd()}/index.html`, 'utf8');
    expect(html.match(/class="chat-image-draft-list"/g)).toHaveLength(1);
    expect(html).not.toContain("removeChatFileDraft(draft.draft_id, 'message')");
    expect(html).toContain("removeChatFileDraft(draft.draft_id, 'thread')");
    expect(html).toContain('data-chat-image-preview-close');
    expect(html).toContain('@keydown.escape.window="$store.chat.chatImagePreviewModal.open');
  });
});
