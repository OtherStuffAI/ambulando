// Tower stores a typed descriptor. Navigation belongs to the WApp's authenticated
// same-origin catalog; Flight Deck never reads a private cross-origin catalog.
export function canonicalContextArtifact(target) {
  try {
    const origin = new URL(target?.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || !/^[A-Za-z0-9_-]{1,128}$/.test(target.project) || !/^[A-Za-z0-9_-]{1,128}$/.test(target.artifact)
      || target.page !== 'index.html' || target.version_policy !== 'latest') return null;
    return {origin:origin.origin,project:target.project,artifact:target.artifact,page:'index.html',version_policy:'latest'};
  } catch { return null; }
}
export function contextArtifactOrigin(target) { return canonicalContextArtifact(target)?.origin || ''; }
export function contextArtifactLatestUrl(target) {
  const canonical = canonicalContextArtifact(target);
  return canonical ? `${canonical.origin}/artifacts/${encodeURIComponent(canonical.project)}/${encodeURIComponent(canonical.artifact)}/` : '';
}
