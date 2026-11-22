// Versioned, Ambulando-controlled extension contract. No runtime installation.
export const ARTEFACT_CONTRACT_VERSION = 1;
export const ARTEFACT_TYPES = Object.freeze([
  Object.freeze({ id: 'document', label: 'Document', formatVersion: 1, editor: 'builtin.document', templates: ['blank'], styles: ['default'] }),
  Object.freeze({ id: 'excalidraw', label: 'Whiteboard', formatVersion: 1, editor: 'builtin.excalidraw', templates: ['blank'], styles: ['default'] }),
  Object.freeze({ id: 'html', label: 'Interactive HTML', formatVersion: 1, editor: 'builtin.html', templates: ['blank'], styles: ['default'] }),
]);
export function artefactType(row) {
  if (row?.pg_record_type !== 'file') return 'document';
  const meta = row.pg_file_metadata || row.metadata || {};
  if (meta.artefact && (meta.artefact.schema_version !== 1 || meta.artefact.format_version !== 1 || !['builtin.html', 'builtin.excalidraw'].includes(meta.artefact.editor_id))) return null;
  const mime = String(row.content_storage_content_type || row.content_type || '').split(';')[0].trim().toLowerCase();
  const name = String(row.title || row.display_name || row.file_name || '').toLowerCase();
  if (meta.kind === 'excalidraw_board' || mime === 'application/vnd.excalidraw+json' || name.endsWith('.excalidraw')) return 'excalidraw';
  if (meta.html_artifact === true || ['text/html', 'application/xhtml+xml'].includes(mime) || /\.x?html?$/.test(name)) return 'html';
  return null;
}
export function artefactLabel(row) { return ARTEFACT_TYPES.find(type => type.id === artefactType(row))?.label || 'File'; }
