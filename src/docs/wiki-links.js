// Channel-local lookup uses only materialized, readable rows. IDs never fall back
// to title lookup: a deleted target must not silently become a different page.
export function channelWikiPages(documents = [], channelId = '') {
  if (!channelId) return [];
  return documents.filter((doc) => doc.pg_channel_id === channelId
    && !['deleted', 'archived'].includes(doc.record_state)
    && !doc.deleted_at && !doc.archived_at);
}

export function resolveWikiPage(documents, channelId, { documentId, title } = {}) {
  const pages = channelWikiPages(documents, channelId);
  const matches = documentId ? pages.filter((doc) => doc.record_id === documentId)
    : pages.filter((doc) => String(doc.title || '').trim().toLocaleLowerCase() === String(title || '').trim().toLocaleLowerCase());
  if (matches.length === 1) return { state: 'available', page: matches[0], title: matches[0].title };
  return { state: matches.length > 1 ? 'ambiguous' : documentId ? 'unavailable' : 'unresolved', title };
}

export function wikiSource({ documentId, title }) {
  const label = String(title || 'Untitled document');
  return documentId ? `[${label.replace(/([\\`*_{}\[\]()#+\-.!|>&])/g, '\\$1')}](wiki:${encodeURIComponent(documentId)})`
    : `[[${label}]]`;
}

export function bindWikiState(state, documents, channelId) {
  const visit = (node) => {
    if (!node) return node;
    if (node.type === 'fdWikiLink' && !node.attrs?.documentId) {
      const resolved = resolveWikiPage(documents, channelId, node.attrs);
      if (resolved.page) return { ...node, attrs: { ...node.attrs, documentId: resolved.page.record_id } };
    }
    if (!node.content) return node;
    const content = node.content.map(visit);
    return content.some((child, index) => child !== node.content[index]) ? { ...node, content } : node;
  };
  return visit(state);
}
