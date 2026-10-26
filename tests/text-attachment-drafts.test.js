// @vitest-environment jsdom
import 'fake-indexeddb/auto';
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



function pasteEvent(target, text) {
  return { currentTarget: target, preventDefault: vi.fn(), clipboardData: { items: [], getData: () => text } };
}

describe('durable text attachment drafts', () => {
  it('keeps pasted bytes across a reload and discards them once sent', async () => {
    const first = await createStore();
    const { openWorkspaceDb, listTextAttachmentDrafts } = await import('../src/db.js');
    await openWorkspaceDb(`durable-${crypto.randomUUID()}`);
    first.selectedChannelId = 'channel-1';
    first.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    const target = composerAt('hello', 5);
    const text = 'é😀\r\n' + 'k'.repeat(2600);
    // Offline: the upload fails but the draft must survive.
    first.uploadChatFileDraft = vi.fn();
    await first.handleMentionComposerPaste(pasteEvent(target, text), 'message');
    const key = first.getChatComposerDraftKey('message');
    await vi.waitFor(async () => expect(await listTextAttachmentDrafts(key)).toHaveLength(1));
    const [row] = await listTextAttachmentDrafts(key);
    expect(row.status).toBe('pending');
    expect(Array.from(row.bytes))
      .toEqual(Array.from(new TextEncoder().encode(text)));

    // "Reload": a fresh store restores the draft for the same destination.
    const second = first;
    second.messageFileDrafts = [];
    second.selectedChannelId = 'channel-1';
    second.channels = first.channels;
    second.uploadChatFileDraft = vi.fn();
    await second.restoreTextAttachmentDrafts('message');
    expect(second.messageFileDrafts).toHaveLength(1);
    expect(second.messageFileDrafts[0]).toMatchObject({ filename: 'Pasted text.txt', status: 'error', text_attachment: { v: 1, chars: 2604 } });
    expect(second.uploadChatFileDraft).toHaveBeenCalledWith(row.draft_id, 'message');
    await second.restoreTextAttachmentDrafts('message');
    expect(second.messageFileDrafts).toHaveLength(1);

    // Removing it deletes the durable row; sending clears it the same way.
    second.removeChatFileDraft(row.draft_id, 'message');
    await vi.waitFor(async () => expect(await listTextAttachmentDrafts(key)).toHaveLength(0));
  });
});
