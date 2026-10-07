import { messageActivityContext, messageActivityLifecycle, messageActivityPartition } from '../message-activity/projection.js';
export const orgDataContext = messageActivityContext;
export const orgDataLifecycle = messageActivityLifecycle;
export const orgDataPartition = messageActivityPartition;
import { normalizeOrgSnapshot } from './normalize.js';
export function normalizeOrgData(payload, c, requestId) { return { ...normalizeOrgSnapshot(payload, c, requestId), key: orgDataPartition(c) }; }
export function projectOrgData(row) { return { bundles: row.bundles, types: row.types, records: row.records, capabilities: row.capabilities, identities: row.identities, changes: row.changes, installations: row.installations?.map(({html,...b}) => b) };  }
export const NAPPLET_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export function sandboxBundle(html, session) {
  // This first CSP is host-owned; subsequent policies can only restrict it.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${NAPPLET_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.nappletSession=${JSON.stringify(session)};</script></head><body>${html}</body></html>`;
}
