import { markdownToProseMirrorDoc } from './markdown-to-prosemirror.js';

function normalizedMarks(marks = []) {
  return (Array.isArray(marks) ? marks : [])
    .map((mark) => {
      const type = String(mark?.type || '').trim();
      if (!type) return null;
      if (type === 'link') {
        return { type, href: String(mark?.attrs?.href || ''), title: String(mark?.attrs?.title || '') };
      }
      if (type === 'fdMention') {
        return {
          type,
          mentionType: String(mark?.attrs?.mentionType || ''),
          mentionId: String(mark?.attrs?.mentionId || ''),
          label: String(mark?.attrs?.label || ''),
        };
      }
      return { type };
    })
    .filter(Boolean)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function storageSource(node = {}) {
  const objectId = String(node?.attrs?.objectId || '').trim();
  if (objectId) return `storage://${objectId}`;
  return String(node?.attrs?.src || '').trim();
}

function appendSemanticTokens(node = {}, tokens = []) {
  if (node.type === 'text') {
    const token = {
      kind: 'text',
      text: String(node.text || ''),
      marks: normalizedMarks(node.marks),
    };
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'text' && JSON.stringify(previous.marks) === JSON.stringify(token.marks)) {
      previous.text += token.text;
    } else if (token.text) {
      tokens.push(token);
    }
    return tokens;
  }
  if (node.type === 'fdWikiLink') {
    tokens.push({ kind: 'wiki', documentId: node.attrs?.documentId || null, title: node.attrs?.title || '' });
    return tokens;
  }
  if (node.type === 'hardBreak') {
    tokens.push({ kind: 'break' });
    return tokens;
  }
  if (node.type === 'fdStorageImage' || node.type === 'image') {
    tokens.push({
      kind: 'image',
      src: storageSource(node),
      alt: String(node?.attrs?.alt || ''),
    });
    return tokens;
  }
  if (node.type === 'fdStorageFile') {
    const label = String(node?.attrs?.label || node?.attrs?.title || node?.attrs?.src || 'File');
    tokens.push({
      kind: 'text',
      text: label,
      marks: [{ type: 'link', href: String(node?.attrs?.src || ''), title: '' }],
    });
    return tokens;
  }
  const children = Array.isArray(node.content) ? node.content : [];
  for (const child of children) {
    appendSemanticTokens(child, tokens);
  }
  return tokens;
}

export function documentEditorSemanticTokens(editorState = {}) {
  return appendSemanticTokens(
    editorState?.type === 'doc' ? editorState : { type: 'doc', content: [] },
    [],
  );
}

export function validateDocumentContentModelRoundTrip(contentModel = {}) {
  if (contentModel?.editor_state?.type !== 'doc') {
    return { ok: false, reason: 'missing_editor_state' };
  }
  try {
    const reparsed = markdownToProseMirrorDoc(contentModel.content || '', {
      contentBlocks: contentModel.content_blocks || [],
    });
    const expectedTokens = documentEditorSemanticTokens(contentModel.editor_state);
    const actualTokens = documentEditorSemanticTokens(reparsed);
    if (JSON.stringify(expectedTokens) !== JSON.stringify(actualTokens)) {
      return {
        ok: false,
        reason: 'semantic_content_mismatch',
        expectedTokenCount: expectedTokens.length,
        actualTokenCount: actualTokens.length,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'round_trip_parse_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
