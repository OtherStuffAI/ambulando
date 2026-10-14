const { test, expect } = require('playwright/test');
const { buildSync } = require('esbuild');
const path = require('node:path');

const signerBundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../../src/auth/nostr.js')],
  bundle: true, write: false, format: 'iife', globalName: 'signerUnderTest',
  platform: 'browser',
}).outputFiles[0].text;

test('native document revocation rejects queued and late work, then accepts a fresh host provider', async ({ page }) => {
  await page.goto('/');
  await page.addScriptTag({ content: signerBundle });
  const result = await page.evaluate(async () => {
    const signer = signerUnderTest;
    localStorage.setItem('signer-lifecycle-retained-draft', 'keep my edit');
    let release;
    let oldCalls = 0;
    window.nostr = {
      __wingman: true,
      getPublicKey: async () => 'public-key',
      signEvent: () => { oldCalls++; return new Promise(resolve => { release = resolve; }); },
    };
    const capture = promise => promise.then(() => 'accepted', error => error.message);
    const active = capture(signer.signEventWithExtension({ kind: 27235 }));
    await Promise.resolve();
    const queued = capture(signer.signEventWithExtension({ kind: 27235 }));
    window.nostr = {
      __wingman: true,
      getPublicKey: async () => { throw new Error('Signer document revoked.'); },
      signEvent: async () => { throw new Error('Signer document revoked.'); },
    };
    const revoked = await capture(signer.getExtensionPublicKey());
    const pausedCode = signer.nativeSignerRecoveryError()?.code;
    release({ pubkey: 'public-key' });
    const stale = await Promise.all([active, queued]);
    window.nostr = {
      __wingman: true,
      getPublicKey: async () => 'public-key',
      signEvent: async event => ({ ...event, pubkey: 'public-key' }),
    };
    const recovered = await signer.signEventWithExtension({ kind: 27235 });
    const draft = localStorage.getItem('signer-lifecycle-retained-draft');
    localStorage.removeItem('signer-lifecycle-retained-draft');
    return { revoked, pausedCode, stale, oldCalls, recovered: recovered.pubkey, draft, blocked: signer.nativeSignerRecoveryError() };
  });
  expect(result.pausedCode).toBe('native_signer_document_revoked');
  expect(result.revoked).toContain('Keep stored data intact');
  expect(result.stale.every(message => message !== 'accepted')).toBe(true);
  expect(result.oldCalls).toBe(1);
  expect(result.recovered).toBe('public-key');
  expect(result.draft).toBe('keep my edit');
  expect(result.blocked).toBeNull();
});
