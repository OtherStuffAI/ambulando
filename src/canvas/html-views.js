// Viewer-local HTML version browsing state. A "view" is a version the viewer
// opened that differs from the naplet's shared policy. Views are reconciled
// against every fresh Canvas snapshot so a browsed version never outlives the
// authority that produced it.

export const htmlAssetKey = asset => `${asset.file_id}:${asset.version_id}:${asset.sha256}`;

export function htmlPolicyKey(naplet) {
  return `${naplet?.source?.version_id || 'latest'}:${naplet?.content?.version_id || ''}:${naplet?.content?.current_version_id || ''}`;
}

const readyHtmlNaplets = naplets => (naplets || []).filter(row => row.access === 'ready' && row.source?.type === 'html');
const readyAssets = assets => (assets || []).filter(asset => asset.status === 'ready');

/**
 * Reconcile browsing views with a snapshot identified by `authority` (its
 * request id). Views for removed or denied naplets are dropped; a changed
 * policy or latest version returns the viewer to the naplet's version. A
 * browsed version authorized by an earlier read keeps only assets the fresh
 * snapshot also vouches for and is listed in `revalidate` for a re-read.
 * `keep` is every asset still displayable, for the byte cache.
 */
export function reconcileHtmlViews(views, naplets, authority) {
  const ready = readyHtmlNaplets(naplets);
  const vouched = new Set(ready.flatMap(row => readyAssets(row.content?.assets).map(htmlAssetKey)));
  const next = {}, revalidate = [];
  for (const naplet of ready) {
    const view = views?.[naplet.id];
    if (!view) continue;
    const policyKey = htmlPolicyKey(naplet);
    if (view.policyKey !== policyKey) {
      // The version list may predate a new publish; it reloads on demand.
      next[naplet.id] = { versions: [], policyKey, content: null, authority };
      continue;
    }
    if (!view.content || view.authority === authority) {
      next[naplet.id] = { ...view, authority };
      continue;
    }
    const assets = (view.content.assets || []).map(asset => asset.status === 'ready' && !vouched.has(htmlAssetKey(asset)) ? { name: asset.name, status: 'unavailable' } : asset);
    next[naplet.id] = { ...view, content: { ...view.content, assets }, authority };
    revalidate.push({ napletId: naplet.id, versionId: view.content.version_id });
  }
  return { views: next, revalidate, keep: htmlDisplayedAssets(ready, next) };
}

export function htmlDisplayedAssets(naplets, views) {
  return [
    ...readyHtmlNaplets(naplets).flatMap(row => readyAssets(row.content?.assets)),
    ...Object.values(views || {}).flatMap(view => readyAssets(view?.content?.assets)),
  ];
}

/**
 * Orders asynchronous browse reads. A result applies only if it is the
 * newest request for that naplet, the naplet is still ready under the same
 * policy and no fresh authority (snapshot, error or clear) arrived while it
 * was in flight. `stale` distinguishes "superseded" from "authority moved".
 */
export class HtmlViewSequencer {
  constructor() { this.epoch = 0; this.requests = new Map(); }
  advance() { this.epoch += 1; }
  begin(napletId) {
    const seq = (this.requests.get(napletId) || 0) + 1;
    this.requests.set(napletId, seq);
    return { napletId, seq, epoch: this.epoch };
  }
  superseded(ticket) { return this.requests.get(ticket.napletId) !== ticket.seq; }
  authorityMoved(ticket) { return ticket.epoch !== this.epoch; }
}
