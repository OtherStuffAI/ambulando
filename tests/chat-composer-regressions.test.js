// @vitest-environment jsdom
// Exercise actual app methods without bootstrapping transport or IndexedDB.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Alpine from 'alpinejs';
import * as textComposer from '../src/text-attachment-composer.js';
import * as composer from '../src/mention-composer.js';
import * as drafts from '../src/chat-composer-draft.js';
import { installStableHtml } from '../src/stable-html.js';
import { preserveHydratedDocumentContent } from '../src/document-selection.js';
import { defaultRecordSignature, sameListBySignature } from '../src/utils/state-helpers.js';
import { renderMarkdownToHtml } from '../src/markdown.js';

const app = readFileSync('src/app.js', 'utf8');
const chat = readFileSync('src/chat-message-manager.js', 'utf8');
const bindings = { ...textComposer, ...composer, ...drafts, preserveHydratedDocumentContent, defaultRecordSignature, sameListBySignature, renderMarkdownToHtml,
  MENTION_COMPOSER_MODELS: new WeakMap(), MENTION_COMPOSER_ELEMENTS: new WeakMap(), markdownRenderCaches: new WeakMap() };
for (const [name, end] of [['renderMarkdownCached', '// Constants'], ['documentRecordSignature', '\nconst NUMBER_FORMATTER']]) {
  const start = app.indexOf(`function ${name}(`);
  bindings[name] = new Function(...Object.keys(bindings), `${app.slice(start, app.indexOf(end, start))}; return ${name};`)(...Object.values(bindings));
}
function method(source, name, indent = 4) {
  const prefix = ' '.repeat(indent), start = source.indexOf(`\n${prefix}${name}(`) + 1;
  if (!start) throw new Error(`Missing method ${name}`);
  const end = source.indexOf(`\n${prefix}},`, start) + prefix.length + 3;
  return new Function(...Object.keys(bindings), `return ({${source.slice(start, end)}}).${name}`)(...Object.values(bindings));
}
beforeAll(() => { installStableHtml(Alpine); Alpine.start(); });
afterEach(() => { [...document.body.children].forEach(el => Alpine.destroyTree(el)); document.body.replaceChildren(); });
async function setup(context = 'thread', value = '') {
  const state = { documents: [{ record_id: 'doc', title: 'Stable', version: 1, updated_at: '1' }], body: '![image](storage://object)',
    threadInput: context === 'thread' ? value : '', messageInput: context === 'message' ? value : '',
    composerDraftHasText: {}, selectedAgentMentionsByComposer: {}, selectedChannelId: 'channel', activeThreadChannelId: 'channel', activeThreadId: 'thread',
    channels: [], currentWorkspaceKey: 'isolated', chatComposerDrafts: {}, fileDrafts: [],
    getChatFileDrafts() { return this.fileDrafts; }, autosizeComposer() {}, scheduleComposerElementAutosize() {}, scheduleComposerAutosize() {}, refreshOpenDocFromLatestDocument() {}, updatePageTitle() {} };
  for (const name of ['initMentionComposer', 'syncMentionComposerModel', 'syncMentionComposerDraft', 'syncMentionComposerFromModel', 'commitMentionComposerDraft', 'applyDocuments', 'renderMarkdown', 'resolveChatFileDraftInlineToken']) state[name] = method(app, name);
  for (const name of ['getChatComposerDraftKey', 'saveChatComposerDraft', 'restoreChatComposerDraft']) state[name] = method(chat, name, 2);
  Alpine.store('chat', state);
  const root = document.createElement('section');
  root.setAttribute('x-data', '{}');
  root.innerHTML = `<div id="message" x-stable-html="$store.chat.renderMarkdown($store.chat.body)"></div><div id="editor" contenteditable="true" tabindex="0" data-chat-composer="${context}" x-init="$store.chat.initMentionComposer($el, '${context}'); $watch('$store.chat.${context === 'thread' ? 'threadInput' : 'messageInput'}', value => $store.chat.syncMentionComposerFromModel($el, '${context}', value))" @input="$store.chat.syncMentionComposerDraft($event.currentTarget)"></div>`;
  document.body.append(root); Alpine.initTree(root); await Alpine.nextTick();
  const store = Alpine.store('chat'), el = root.querySelector('#editor');
  const upload = (token) => { const draft = { draft_id: String(store.fileDrafts.length), inline_upload_token: token, composer_draft_key: store.getChatComposerDraftKey(context) }; store.fileDrafts.push(draft); return draft; };
  return { store, el, upload, model: context === 'thread' ? 'threadInput' : 'messageInput' };
}
function select(el, node, start, end = start) { el.focus(); document.getSelection().setBaseAndExtent(node, start, node, end); }
function type(el, text) { el.append(document.createTextNode(text)); el.dispatchEvent(new Event('input', { bubbles: true })); }
const text = composer.serializeMentionComposer;

describe('live owning composer upload resolution', () => {
  it.each(['message', 'thread'])('preserves deferred typing and backward selection for %s', async (context) => {
    const { store, el, upload, model } = await setup(context, 'before [upload]');
    const draft = upload('[upload]'); type(el, ' typing while uploading');
    select(el, el.lastChild, 10, 3);
    expect(store[model]).toBe('before [upload]');
    store.resolveChatFileDraftInlineToken(draft.draft_id, context, '![image](storage://done)'); await Alpine.nextTick();
    expect(text(el)).toBe('before ![image](storage://done) typing while uploading');
    expect(document.activeElement).toBe(el);
    expect(document.getSelection().anchorOffset).toBe(10);
    expect(document.getSelection().focusOffset).toBe(3);
    expect(document.getSelection().anchorNode).toBe(el.lastChild);
  });
  it('preserves mentions, caret before token, split tokens, and multiple out-of-order completions', async () => {
    const { store, el, upload } = await setup('thread', '@[Pat](mention:person:npub-test) before [one] [two]');
    const pill = el.firstChild, one = upload('[one]'), two = upload('[two]');
    el.lastChild.splitText(10); select(el, el.childNodes[1], 2);
    store.resolveChatFileDraftInlineToken(two.draft_id, 'thread', 'second');
    store.resolveChatFileDraftInlineToken(one.draft_id, 'thread', 'first'); await Alpine.nextTick();
    expect(text(el)).toBe('@[Pat](mention:person:npub-test) before first second');
    expect(el.firstChild).toBe(pill);
    expect(document.getSelection().anchorOffset).toBe(2);
    expect(store.selectedAgentMentionsByComposer.thread[0].label).toBe('Pat');
  });
  it.each(['', '[ Image upload failed ]'])('preserves live text when replacing with %j', async replacement => {
    const { store, el, upload } = await setup('thread', '[upload]');
    const draft = upload('[upload]'); type(el, ' unsent'); select(el, el.lastChild, 4);
    store.resolveChatFileDraftInlineToken(draft.draft_id, 'thread', replacement); await Alpine.nextTick();
    expect(text(el)).toBe(replacement + ' unsent'); expect(document.getSelection().anchorOffset).toBe(4);
  });
  it.each(['message', 'thread'])('patches only saved source after %s navigation, even when attachment list clears', async context => {
    const { store, el, upload } = await setup(context, '[upload]');
    const draft = upload('[upload]'); type(el, ' unsent'); const key = draft.composer_draft_key;
    store.saveChatComposerDraft(context);
    store.selectedChannelId = 'other'; store.activeThreadChannelId = 'other'; store.activeThreadId = 'other-thread';
    store.restoreChatComposerDraft(context); await Alpine.nextTick(); type(el, 'destination');
    store.fileDrafts = [];
    store.resolveChatFileDraftInlineToken(draft.draft_id, context, 'done', draft); await Alpine.nextTick();
    expect(text(el)).toBe('destination'); expect(store.chatComposerDrafts[key].value).toBe('done unsent');
    store.saveChatComposerDraft(context);
    store.selectedChannelId = 'channel'; store.activeThreadChannelId = 'channel'; store.activeThreadId = 'thread';
    store.restoreChatComposerDraft(context); await Alpine.nextTick(); expect(text(el)).toBe('done unsent');
  });
  it('waits for IME final input and resolves multiple uploads without dropping composition', async () => {
    const { store, el, upload } = await setup('thread', '[one] [two]');
    const one = upload('[one]'), two = upload('[two]');
    el.dispatchEvent(new CompositionEvent('compositionstart')); type(el, 'に'); select(el, el.lastChild, 1);
    store.resolveChatFileDraftInlineToken(one.draft_id, 'thread', 'one'); store.resolveChatFileDraftInlineToken(two.draft_id, 'thread', 'two');
    expect(text(el)).toBe('[one] [two]に');
    el.dispatchEvent(new CompositionEvent('compositionend')); el.lastChild.nodeValue = '日本'; select(el, el.lastChild, 2);
    el.dispatchEvent(new Event('input', { bubbles: true })); await Alpine.nextTick();
    expect(text(el)).toBe('one two日本'); expect(document.getSelection().anchorOffset).toBe(2);
  });
  it('restores empty-model destinations without leaving the previous live DOM behind', async () => {
    const { store, el } = await setup('message'); type(el, 'unsent source');
    store.saveChatComposerDraft('message'); store.selectedChannelId = 'other';
    store.restoreChatComposerDraft('message'); await Alpine.nextTick(); expect(text(el)).toBe('');
    type(el, 'unsent destination'); store.saveChatComposerDraft('message');
    store.selectedChannelId = 'channel'; store.restoreChatComposerDraft('message'); await Alpine.nextTick();
    expect(text(el)).toBe('unsent source');
  });
  it.each(['thread', 'workspace'])('keeps source ownership after a %s-only switch during IME', async changed => {
    const { store, el, upload } = await setup('thread', '[upload]'); const draft = upload('[upload]');
    el.dispatchEvent(new CompositionEvent('compositionstart')); type(el, '日本');
    store.resolveChatFileDraftInlineToken(draft.draft_id, 'thread', 'done'); store.saveChatComposerDraft('thread');
    if (changed === 'thread') store.activeThreadId = 'other-thread'; else store.currentWorkspaceKey = 'other-workspace';
    store.restoreChatComposerDraft('thread'); await Alpine.nextTick(); type(el, 'destination');
    el.dispatchEvent(new CompositionEvent('compositionend')); await Alpine.nextTick();
    expect(text(el)).toBe('destination'); expect(store.chatComposerDrafts[draft.composer_draft_key].value).toBe('done日本');
  });
  it('finishes a queued upload in the saved source when navigation unmounts an IME editor', async () => {
    const { store, el, upload } = await setup('thread', '[upload]'); const draft = upload('[upload]');
    el.dispatchEvent(new CompositionEvent('compositionstart')); type(el, '日本');
    store.resolveChatFileDraftInlineToken(draft.draft_id, 'thread', 'done'); store.saveChatComposerDraft('thread');
    el.remove(); store.activeThreadId = 'other-thread'; store.restoreChatComposerDraft('thread'); await Alpine.nextTick();
    expect(store.chatComposerDrafts[draft.composer_draft_key].value).toBe('done日本'); expect(store.threadInput).toBe('');
  });
  it('maps a selection spanning a token across browser line breaks', async () => {
    const { store, el, upload } = await setup('thread'); const draft = upload('[upload]');
    el.innerHTML = '<div>before</div><div>[upload] after</div>';
    el.dispatchEvent(new Event('input', { bubbles: true })); el.focus();
    document.getSelection().setBaseAndExtent(el.firstChild.firstChild, 2, el.lastChild.firstChild, 11);
    store.resolveChatFileDraftInlineToken(draft.draft_id, 'thread', 'done'); await Alpine.nextTick();
    expect(text(el)).toBe('before\ndone after');
    expect(document.getSelection().toString()).toBe('foredone af');
  });
  it('saves live draft without committing a reactive string on every keystroke', async () => {
    const { store, el } = await setup('thread', 'saved'); type(el, ' plus unsent');
    store.saveChatComposerDraft('thread'); expect(store.threadInput).toBe('saved');
    store.threadInput = 'elsewhere'; await Alpine.nextTick(); store.restoreChatComposerDraft('thread'); await Alpine.nextTick();
    expect(text(el)).toBe('saved plus unsent');
  });
});

describe('stable source HTML through actual document updates', () => {
  it('keeps hydrated image identity/src for equivalent and changed metadata; renders edits repeatedly', async () => {
    const { store } = await setup();
    const img = document.querySelector('img'); img.src = 'blob:hydrated';
    store.applyDocuments([{ record_id: 'doc', title: 'Stable', version: 1, updated_at: '1' }]); await Alpine.nextTick();
    expect(document.querySelector('img')).toBe(img);
    store.applyDocuments([{ record_id: 'doc', title: 'Stable', version: 2, updated_at: '2' }]); await Alpine.nextTick();
    expect(document.querySelector('img')).toBe(img); expect(img.getAttribute('src')).toBe('blob:hydrated');
    store.body = '![edited](storage://new-object)'; await Alpine.nextTick();
    const edited = document.querySelector('img'); expect(edited).not.toBe(img); expect(edited.dataset.storageObjectId).toBe('new-object');
    edited.src = 'blob:new-hydrated';
    store.applyDocuments([{ record_id: 'doc', title: 'Renamed', version: 3, updated_at: '3' }]); await Alpine.nextTick();
    expect(document.querySelector('img')).toBe(edited); expect(edited.getAttribute('src')).toBe('blob:new-hydrated');
    store.body = '**changed again**'; await Alpine.nextTick(); expect(document.querySelector('#message strong').textContent).toBe('changed again');
  });
});
