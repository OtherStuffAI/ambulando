// Device-local consent only. Receipts never replace live File/channel authority.
const PREFIX = 'napplet-approval-v1:';
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
const revoked = new Set();

export async function nappletReceipt(context, codeFileId, digest, binding, canWrite) {
  const required = [context.baseUrl, context.appNpub, context.workspaceId, context.viewer, codeFileId, binding?.fileId];
  if (required.some(value => typeof value !== 'string' || !value.trim()) || !/^[a-f0-9]{64}$/.test(digest) || binding.appId !== 'daily-tracker' || typeof canWrite !== 'boolean') throw new Error('Napplet approval identity is incomplete.');
  const backend = new URL(context.baseUrl);
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password) throw new Error('Invalid napplet backend.');
  const identity = [backend.href.replace(/\/$/, ''), context.tower || '', context.service || '', context.appNpub, context.workspaceId, context.viewer];
  // One slot per code File: approving changed code/access replaces old consent.
  const key = PREFIX + await sha([...identity, codeFileId]);
  const fingerprint = await sha({ version: 1, identity, codeFileId, digest, appId: binding.appId, manifestVersion: 1, bindings: [{ name: 'tracker', fileId: binding.fileId, format: 'daily-tracker-v1', privacy: 'self', operations: ['read', 'save'] }], canWrite });
  return Object.freeze({ key, fingerprint });
}
export function hasNappletApproval(receipt) {
  try {
    if (revoked.has(receipt.key)) return false;
    const stored = JSON.parse(globalThis.localStorage.getItem(receipt.key));
    return stored?.version === 1 && stored.fingerprint === receipt.fingerprint && Object.keys(stored).sort().join(',') === 'fingerprint,version';
  } catch { return false; }
}
export function rememberNappletApproval(receipt) {
  try {
    const value = JSON.stringify({ version: 1, fingerprint: receipt.fingerprint });
    globalThis.localStorage.setItem(receipt.key, value);
    if (globalThis.localStorage.getItem(receipt.key) !== value) return false;
    revoked.delete(receipt.key);
    return true;
  } catch { return false; }
}
export function forgetNappletApproval(receipt) {
  revoked.add(receipt.key);
  try {
    globalThis.localStorage.removeItem(receipt.key);
    return globalThis.localStorage.getItem(receipt.key) === null;
  } catch { return false; }
}

// Separate discriminated receipt; never widens the Daily Metrics binding parser.
export async function workspaceReportReceipt(context, codeFileId, digest, binding, codeAccess) {
  if (binding?.appId !== 'workspace-report' || binding.workspaceId !== context.workspaceId || typeof codeAccess !== 'boolean' || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid report approval identity.');
  const required = [context.baseUrl, context.appNpub, context.workspaceId, context.viewer, codeFileId];
  if (required.some(v => typeof v !== 'string' || !v.trim())) throw Error('Incomplete report approval identity.');
  const backend = new URL(context.baseUrl);
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password) throw Error('Invalid report backend.');
  const identity = [backend.href.replace(/\/$/, ''), context.tower || '', context.service || '', context.appNpub, context.workspaceId, context.viewer];
  return Object.freeze({ key: PREFIX + await sha([...identity, codeFileId]), fingerprint: await sha({version:1, identity, codeFileId, digest, appId:'workspace-report', manifestVersion:1, bindings:[{name:'report',workspaceId:binding.workspaceId,format:'workspace-report-v1',privacy:'viewer',operations:['read']}], codeAccess, canWrite:false}) });
}
