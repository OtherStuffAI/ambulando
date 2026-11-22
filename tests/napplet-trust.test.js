import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nappletReceipt, hasNappletApproval, rememberNappletApproval, forgetNappletApproval } from '../src/napplets/trust.js';
const context = { baseUrl: 'https://tower.example', appNpub: 'app', workspaceId: 'workspace', viewer: 'alice', tower: 'tower', service: 'service' };
const binding = { appId: 'daily-tracker', fileId: 'data-file' };
const receipt = (c = context, digest = 'a'.repeat(64), b = binding, canWrite = true) => nappletReceipt(c, 'code-file', digest, b, canWrite);
let values;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it('requires explicit approval, persists only hashes, and reuses unchanged consent after data edits', async () => {
  const r = await receipt(); expect(hasNappletApproval(r)).toBe(false);
  expect(rememberNappletApproval(r)).toBe(true);
  expect(hasNappletApproval(await receipt({ ...context, dataVersion: 'new', value: { private: 75 } }))).toBe(true);
  expect([...values.values()]).toEqual([JSON.stringify({ version: 1, fingerprint: r.fingerprint })]);
  expect([...values.keys()][0]).toMatch(/^napplet-approval-v1:[a-f0-9]{64}$/);
});
it('isolates every authority identity and does not fall back between backends or viewers', async () => {
  rememberNappletApproval(await receipt());
  for (const key of ['baseUrl', 'appNpub', 'workspaceId', 'viewer', 'tower', 'service']) {
    const value = key === 'baseUrl' ? 'https://other.example' : 'other';
    expect(hasNappletApproval(await receipt({ ...context, [key]: value }))).toBe(false);
  }
});
it('requires approval for changed code, bound File and effective permissions and replaces old receipt', async () => {
  const first = await receipt(); rememberNappletApproval(first);
  for (const r of [await receipt(context, 'b'.repeat(64)), await receipt(context, undefined, { ...binding, fileId: 'other' }), await receipt(context, undefined, undefined, false)]) expect(hasNappletApproval(r)).toBe(false);
  const changed = await receipt(context, 'b'.repeat(64)); rememberNappletApproval(changed);
  expect(hasNappletApproval(first)).toBe(false);
  expect(forgetNappletApproval(changed)).toBe(true);
  expect(hasNappletApproval(changed)).toBe(false);
});
it('fails closed for malformed, overpermissive and denied storage; failed revocation is not reported as success', async () => {
  const r = await receipt();
  for (const bad of ['broken', 'null', '{}', JSON.stringify({ version: 1, fingerprint: r.fingerprint, extra: true })]) { values.set(r.key, bad); expect(hasNappletApproval(r)).toBe(false); }
  vi.stubGlobal('localStorage', { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('denied'); } });
  expect(hasNappletApproval(r)).toBe(false); expect(rememberNappletApproval(r)).toBe(false); expect(forgetNappletApproval(r)).toBe(false);
});
it('rejects incomplete identities, unverifiable digests and unsupported apps', async () => {
  await expect(receipt({ ...context, viewer: '' })).rejects.toThrow();
  await expect(receipt(context, 'draft:1')).rejects.toThrow();
  await expect(receipt(context, undefined, { ...binding, appId: 'arbitrary-html' })).rejects.toThrow();
});
