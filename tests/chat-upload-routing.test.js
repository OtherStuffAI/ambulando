import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDiagnosticOperation, finishDiagnosticOperation, emitDiagnostic } from '../src/diagnostics-events.js';
import { resolveChatUploadToken } from '../src/chat-composer-draft.js';
// Exercise the actual app methods without bootstrapping browser transport or Dexie.
const candidate = readFileSync('src/app.js', 'utf8');
function method(source, name, bindings) {
  const re = new RegExp(`\\n    (?:async )?${name}\\(`);
  const start = source.search(re) + 1;
  assert.ok(start, name);
  const end = source.indexOf('\n    },', start) + 7;
  return new Function(...Object.keys(bindings), `return ({${source.slice(start, end)}}).${name}`)(
    ...Object.values(bindings),
  );
}
function gate() {
  let release;
  return { promise: new Promise((r) => (release = r)), release: () => release() };
}
async function tick() {
  await new Promise((r) => setImmediate(r));
}
function fixture(source = candidate, { delay, fail } = {}) {
  const calls = [];
  const routes = [];
  const wait = gate();
  let key = 'source';
  const bindings = {
    isTowerPgBackendMode: () => true,
    buildStoragePrepareBody: (x) => x,
    prepareStorageObject: async () => {},
    prepareTowerPgStorageObject: async (w, b, o) => {
      calls.push('prepare');
      routes.push(o.baseUrl);
      if (delay === 'prepare') await wait.promise;
      if (fail === 'prepare') throw Object.assign(new Error('revoked'), { status: 403 });
      return { object_id: 'object' };
    },
    uploadStorageObject: async (p, b, t, o = {}) => {
      calls.push('transfer');
      routes.push(o.baseUrl || 'https://default.example');
      if (delay === 'transfer') await wait.promise;
      if (fail === 'transfer') throw new Error('truncated body');
    },
    completeStorageObject: async (p, b, o = {}) => {
      calls.push('complete');
      routes.push(o.baseUrl || 'https://default.example');
      if (delay === 'complete') await wait.promise;
      if (fail === 'complete') throw new Error('incomplete body');
    },
    resolveChatUploadToken,
    createDiagnosticOperation, finishDiagnosticOperation, emitDiagnostic,
  };
  const file = {
    arrayBuffer: async () => {
      if (delay === 'read') await wait.promise;
      return new Uint8Array([1]).buffer;
    },
  };
  const draft = {
    draft_id: 'one',
    file,
    content_type: 'image/png',
    filename: 'fixture',
    composer_draft_key: 'source',
    inline_upload_token: '[upload]',
  };
  const store = {
    currentWorkspace: {
      workspaceId: 'source',
      pgBackendMode: true,
      directHttpsUrl: 'https://selected.example',
    },
    currentWorkspaceKey: 'source',
    backendUrl: 'https://default.example',
    workspaceOwnerNpub: 'owner',
    session: { npub: 'session' },
    drafts: [draft],
    messageInput: 'unsent [upload]',
    chatComposerDrafts: {},
    getChatComposerDraftKey: () => key,
    getChatFileDrafts() {
      return this.drafts;
    },
    setChatFileDrafts(c, d) {
      this.drafts = d;
    },
    sha256HexForBytes: async () => {
      if (delay === 'hash') await wait.promise;
      return 'hash';
    },
    createStorageMarkdown: () => '![fixture](storage://object)',
  };
  for (const name of [
    'prepareStorageObjectForCurrentWorkspace',
    'uploadChatFileDraft',
    'resolveChatFileDraftInlineToken',
    ...(source === candidate ? ['captureStorageUploadContext'] : []),
  ])
    store[name] = method(source, name, bindings);
  return {
    store,
    calls,
    routes,
    wait,
    draft,
    switchComposer() {
      store.chatComposerDrafts.source = { value: store.messageInput };
      key = 'destination';
      store.messageInput = 'destination draft';
      store.drafts = [];
    },
    switchWorkspace() {
      this.switchComposer();
      store.currentWorkspace = {
        workspaceId: 'destination',
        pgBackendMode: true,
        directHttpsUrl: 'https://destination.example',
      };
      store.currentWorkspaceKey = 'destination';
      store.workspaceOwnerNpub = 'other-owner';
    },
  };
}
test('candidate pins all three stages to selected backend', async () => {
  const x = fixture();
  await x.store.uploadChatFileDraft('one');
  assert.deepEqual(x.routes, Array(3).fill('https://selected.example'));
  assert.equal(x.store.drafts[0].status, 'ready');
  assert.equal(x.store.messageInput, 'unsent ![fixture](storage://object)');
});
for (const stage of ['read', 'prepare', 'transfer', 'hash'])
  test(`candidate stops subsequent stage after workspace switch during ${stage}`, async () => {
    const x = fixture(candidate, { delay: stage });
    const p = x.store.uploadChatFileDraft('one');
    await tick();
    x.switchWorkspace();
    x.wait.release();
    await p;
    assert.ok(!x.calls.includes('complete'));
    assert.ok(x.routes.every((r) => r === 'https://selected.example'));
    assert.equal(x.store.messageInput, 'destination draft');
    assert.equal(x.store.chatComposerDrafts.source.value, 'unsent [ Image upload failed ]');
  });
test('delayed complete patches saved owning composer, preserves destination', async () => {
  const x = fixture(candidate, { delay: 'complete' });
  const p = x.store.uploadChatFileDraft('one');
  await tick();
  x.switchComposer();
  x.wait.release();
  await p;
  assert.equal(x.store.messageInput, 'destination draft');
  assert.equal(x.store.chatComposerDrafts.source.value, 'unsent ![fixture](storage://object)');
});
for (const stage of ['prepare', 'transfer', 'complete'])
  test(`failure during ${stage} preserves unsent draft and file; never marks ready`, async () => {
    const x = fixture(candidate, { fail: stage });
    await x.store.uploadChatFileDraft('one');
    assert.equal(x.store.drafts[0].status, 'error');
    assert.equal(x.store.drafts[0].file, x.draft.file);
    assert.equal(x.store.messageInput, 'unsent [ Image upload failed ]');
    assert.ok(!x.calls.includes('send'));
  });
test('removal during transfer cannot resurrect attachment or deleted token', async () => {
  const x = fixture(candidate, { delay: 'transfer' });
  const p = x.store.uploadChatFileDraft('one');
  await tick();
  x.store.drafts = [];
  x.store.messageInput = 'unsent';
  x.wait.release();
  await p;
  assert.equal(x.store.drafts.length, 0);
  assert.equal(x.store.messageInput, 'unsent');
});
test('candidate concurrent retry and ready retry never allocate duplicate storage', async () => {
  const x = fixture(candidate, { delay: 'transfer' });
  const a = x.store.uploadChatFileDraft('one');
  const b = x.store.uploadChatFileDraft('one');
  await tick();
  x.wait.release();
  await Promise.all([a, b]);
  await x.store.uploadChatFileDraft('one');
  assert.equal(x.calls.filter((c) => c === 'prepare').length, 1);
  assert.equal(x.calls.filter((c) => c === 'complete').length, 1);
});
test('workspace switch DURING completion cannot patch destination; source saved text receives completed object', async () => {
  const x = fixture(candidate, { delay: 'complete' });
  const p = x.store.uploadChatFileDraft('one');
  await tick();
  x.switchWorkspace();
  x.wait.release();
  await p;
  assert.deepEqual(x.routes, Array(3).fill('https://selected.example'));
  assert.equal(x.store.messageInput, 'destination draft');
  assert.equal(x.store.drafts.length, 0);
  assert.equal(x.store.chatComposerDrafts.source.value, 'unsent ![fixture](storage://object)');
});
test('connection endpoint change during transfer prevents completion signing', async () => {
  const x = fixture(candidate, { delay: 'transfer' });
  const p = x.store.uploadChatFileDraft('one');
  await tick();
  x.store.currentWorkspace.directHttpsUrl = 'https://destination.example';
  x.wait.release();
  await p;
  assert.ok(!x.calls.includes('complete'));
  assert.equal(x.store.drafts[0].status, 'error');
});
