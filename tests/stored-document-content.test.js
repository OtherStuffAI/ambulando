import { it, expect } from 'vitest';
import { decodeDocumentContent, canvasDocumentModel } from '../src/docs/stored-content.js';

it.each(['{"content_model":{"content":"ordinary JSON"}}', '{"content":"ordinary JSON"}', '{"format":"other","content_model":{"content":"text"}}', '{"format":"document_content_v1","content_model":[]}', '{"format":"document_content_v1",', '# Markdown'])('preserves ordinary or malformed input: %s', raw => {
  expect(decodeDocumentContent(raw)).toBeNull();
  expect(canvasDocumentModel(raw)).toEqual({ content: raw });
});

it('preserves model fields and explicitly supports legacy storage models', () => {
  const model = { content: '', content_format: 'native', content_blocks: [{ id: 'block' }], editor_state: { type: 'doc', content: [] }, editor_state_format: 'prosemirror_json', editor_state_version: 1 };
  expect(decodeDocumentContent({ format: 'document_content_v1', content_model: model })).toBe(model);
  expect(decodeDocumentContent(JSON.stringify(model), { allowLegacyModel: true })).toEqual(model);
  expect(canvasDocumentModel(model)).toBe(model);
  expect(decodeDocumentContent(JSON.stringify({ content_model: model }), { allowLegacyModel: true })).toEqual(model);
  expect(decodeDocumentContent(JSON.stringify({ content_model: model }))).toBeNull();
});
