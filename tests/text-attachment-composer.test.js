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
  store.persistTextAttachmentDraft = vi.fn(async () => true);
  store.discardTextAttachmentDraftRows = vi.fn(async () => {});
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
  return { currentTarget: target, preventDefault: vi.fn(), clipboardData: { items: [], getData: (type) => (type === 'text/plain' ? text : '') } };
}

describe('automatic text attachments in the composer', () => {
  async function setup(value = '', offset = 0) {
    const store = await createStore();
    store.selectedChannelId = 'channel-1';
    store.channels = [{ record_id: 'channel-1', title: 'Channel' }];
    const target = composerAt(value, offset);
    return { store, target };
  }

  it('keeps a paste of exactly 2500 characters inline and converts 2501 without touching the composer', async () => {
    const { store, target } = await setup('keep me', 4);
    const inline = pasteEvent(target, 'x'.repeat(2500));
    await store.handleMentionComposerPaste(inline, 'message');
    expect(inline.preventDefault).toHaveBeenCalled();
    expect(store.messageFileDrafts).toHaveLength(0);
    expect(serializeMentionComposer(target)).toBe('keep' + 'x'.repeat(2500) + ' me');

    const second = await setup('keep me', 4);
    const big = pasteEvent(second.target, 'y'.repeat(2501));
    await second.store.handleMentionComposerPaste(big, 'message');
    expect(big.preventDefault).toHaveBeenCalled();
    expect(serializeMentionComposer(second.target)).toBe('keep me');
    expect(second.store.messageFileDrafts).toHaveLength(1);
    const [draft] = second.store.messageFileDrafts;
    expect(draft).toMatchObject({ filename: 'Pasted text.txt', kind: 'file', size_bytes: 2501, text_attachment: { v: 1, source: 'paste', chars: 2501, lines: 1 } });
    expect(document.getSelection().anchorOffset).toBe(4);
  });

  it('numbers repeated pastes and converts when the inline total would pass 10000', async () => {
    const { store, target } = await setup('a'.repeat(9950), 9950);
    await store.handleMentionComposerPaste(pasteEvent(target, 'b'.repeat(60)), 'message');
    expect(store.messageFileDrafts.map((d) => d.filename)).toEqual(['Pasted text.txt']);
    await store.handleMentionComposerPaste(pasteEvent(target, 'c'.repeat(3000)), 'message');
    expect(store.messageFileDrafts.map((d) => d.filename)).toEqual(['Pasted text.txt', 'Pasted text 2.txt']);
    expect(serializeMentionComposer(target)).toBe('a'.repeat(9950));
  });

  it('stores the exact UTF-8 bytes including CRLF in the draft file', async () => {
    const { store, target } = await setup();
    const text = 'é😀\r\n' + 'z'.repeat(2600);
    await store.handleMentionComposerPaste(pasteEvent(target, text), 'message');
    const bytes = new Uint8Array(await store.messageFileDrafts[0].file.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(store.messageFileDrafts[0].text_attachment.lines).toBe(2);
  });

  it('undoes the conversion with ctrl+z only while the composer is unchanged', async () => {
    const { store, target } = await setup('ab', 1);
    const text = 'q'.repeat(3000);
    await store.handleMentionComposerPaste(pasteEvent(target, text), 'message');
    const undo = { currentTarget: target, preventDefault: vi.fn(), ctrlKey: true, key: 'z', isComposing: false };
    store.handleComposerKeydown(undo, vi.fn());
    expect(undo.preventDefault).toHaveBeenCalled();
    expect(store.messageFileDrafts).toHaveLength(0);
    expect(serializeMentionComposer(target)).toBe('ab');
    expect(document.getSelection().anchorOffset).toBe(1);

    const changed = await setup('ab', 1);
    await changed.store.handleMentionComposerPaste(pasteEvent(changed.target, text), 'message');
    hydrateMentionComposer(changed.target, 'abc');
    const late = { currentTarget: changed.target, preventDefault: vi.fn(), ctrlKey: true, key: 'z', isComposing: false };
    changed.store.handleComposerKeydown(late, vi.fn());
    expect(late.preventDefault).not.toHaveBeenCalled();
    expect(changed.store.messageFileDrafts).toHaveLength(1);
  });

  it('undoes repeated huge pastes in reverse order without moving the caret or showing a warning', async () => {
    const { store, target } = await setup('keep', 2);
    await store.handleMentionComposerPaste(pasteEvent(target, 'x'.repeat(12000)), 'message');
    await store.handleMentionComposerPaste(pasteEvent(target, 'y'.repeat(12000)), 'message');
    const undo = { currentTarget: target, preventDefault: vi.fn(), ctrlKey: true, key: 'z' };
    store.handleComposerKeydown(undo, vi.fn());
    expect(store.messageFileDrafts).toHaveLength(1);
    store.handleComposerKeydown(undo, vi.fn());
    expect(store.messageFileDrafts).toHaveLength(0);
    expect(serializeMentionComposer(target)).toBe('keep');
    expect(document.getSelection().anchorOffset).toBe(2);
    expect(store.error).toBeFalsy();
  });

  it('caps typing at 10000 code points without splitting surrogate pairs and reports the counter', async () => {
    const { store, target } = await setup('a'.repeat(9999), 9999);
    const typed = { currentTarget: target, preventDefault: vi.fn(), inputType: 'insertText', data: '😀', isComposing: false };
    store.handleComposerBeforeInput(typed);
    expect(typed.preventDefault).not.toHaveBeenCalled();
    hydrateMentionComposer(target, 'a'.repeat(10000));
    const over = { currentTarget: target, preventDefault: vi.fn(), inputType: 'insertText', data: 'b', isComposing: false };
    store.handleComposerBeforeInput(over);
    expect(over.preventDefault).toHaveBeenCalled();
    store.syncMentionComposerModel(target);
    expect(store.composerCounter.message).toMatchObject({ used: 10000, near: true, over: false });
    const composing = { currentTarget: target, preventDefault: vi.fn(), inputType: 'insertCompositionText', data: 'b', isComposing: true };
    store.handleComposerBeforeInput(composing);
    expect(composing.preventDefault).not.toHaveBeenCalled();
  });
});
