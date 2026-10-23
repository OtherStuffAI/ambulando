// Storage envelopes are recognized by their versioned discriminator. Ordinary
// JSON documents remain Markdown unless a storage caller explicitly allows a
// legacy, unwrapped content model.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const model = value => object(value) && (typeof value.content === 'string' || value.editor_state?.type === 'doc');

export function decodeDocumentContent(value, { allowLegacyModel = false } = {}) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (object(parsed) && parsed.format === 'document_content_v1' && model(parsed.content_model)) return parsed.content_model;
  if (allowLegacyModel && object(parsed) && !parsed.format && model(parsed.content_model)) return parsed.content_model;
  return allowLegacyModel && model(parsed) ? parsed : null;
}

export function canvasDocumentModel(value) {
  return decodeDocumentContent(value) || (model(value) ? value : { content: typeof value === 'string' ? value : '' });
}
