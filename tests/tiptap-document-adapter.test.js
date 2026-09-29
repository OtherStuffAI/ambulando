import { describe, expect, it } from 'vitest';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';
import { prosemirrorToFlightDeckContentModel } from '../src/docs/editor/prosemirror-to-flightdeck.js';
import { documentEditorSemanticTokens, validateDocumentContentModelRoundTrip } from '../src/docs/editor/document-content-integrity.js';
import { createDocumentEditorState } from '../src/docs/editor/document-editor-store.js';
import { shortRichDocumentFixture } from './fixtures/short-rich-document.js';
import { richBreakDocumentFixture } from './fixtures/rich-break-document.js';
import {
  FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT,
  PROSEMIRROR_JSON_FORMAT,
} from '../src/docs/editor/prosemirror-flightdeck-schema.js';
import {
  buildSyntheticLongDocumentFixture,
  SYNTHETIC_LONG_DOCUMENT_LENGTH,
} from './fixtures/synthetic-long-document.js';

describe('Tiptap document adapter', () => {
  it('preserves a short rich timeline with pasted whitespace and complete list-item blocks on reopen', () => {
    const original = shortRichDocumentFixture();
    const snapshot = structuredClone(original);
    let current = prosemirrorToFlightDeckContentModel(original);
    const semanticTree = (node) => ({
      type: node.type,
      ...(node.text ? { text: node.text } : {}),
      ...(node.marks?.length ? { marks: node.marks } : {}),
      ...(node.type === 'heading' ? { level: node.attrs.level } : {}),
      ...(node.type === 'orderedList' ? { start: node.attrs.start } : {}),
      ...(node.content ? { content: ['paragraph', 'heading'].includes(node.type)
        ? documentEditorSemanticTokens({ type: 'doc', content: node.content })
        : node.content.map(semanticTree) } : {}),
    });
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(validateDocumentContentModelRoundTrip(current)).toEqual({ ok: true });
      // Force Markdown reopen instead of reusing the saved editor JSON.
      const reopened = createDocumentEditorState({ ...current, editor_state: null }).contentModel;
      expect(semanticTree(reopened.editor_state)).toEqual(semanticTree(original));
      current = reopened;
    }
    expect(original).toEqual(snapshot);
  });
  it('imports Markdown into ProseMirror JSON and exports Flight Deck compatibility fields', () => {
    const source = [
      '# Spec',
      '',
      'Hello @[Operator A](mention:person:npub1operator-a) with [a link](https://example.com).',
      '',
      '- [x] Done',
      '- [ ] Todo',
      '',
      '![Diagram](storage://object-123)',
    ].join('\n');
    const contentBlocks = [
      { id: 'heading-a', type: 'heading', text: '# Spec' },
      { id: 'paragraph-a', type: 'paragraph', text: 'Hello Operator A' },
      { id: 'tasks-a', type: 'list', text: '- [x] Done\n- [ ] Todo' },
      { id: 'image-a', type: 'image', text: '![Diagram](storage://object-123)' },
    ];

    const doc = markdownToProseMirrorDoc(source, { contentBlocks });
    const model = prosemirrorToFlightDeckContentModel(doc);

    expect(model.content_format).toBe(FLIGHTDECK_PROSEMIRROR_CONTENT_FORMAT);
    expect(model.editor_state_format).toBe(PROSEMIRROR_JSON_FORMAT);
    expect(model.editor_state).toEqual(doc);
    expect(model.content).toContain('# Spec');
    expect(model.content).toContain('Hello @[Operator A](mention:person:npub1operator-a) with');
    expect(model.content).not.toContain('@@[Operator A]');
    expect(model.content).toContain('storage://object-123');
    const paragraph = doc.content.find((node) => node.attrs?.fdBlockId === 'paragraph-a');
    const mentionNode = paragraph.content.find((node) => node.marks?.some((mark) => mark.type === 'fdMention'));
    expect(mentionNode).toMatchObject({
      type: 'text',
      text: 'Operator A',
      marks: [{
        type: 'fdMention',
        attrs: {
          label: 'Operator A',
          mentionType: 'person',
          mentionId: 'npub1operator-a',
        },
      }],
    });
    expect(model.content_blocks.map((block) => block.id)).toEqual([
      'heading-a',
      'paragraph-a',
      'tasks-a',
      'image-a',
    ]);
  });

  it('exports rich pasted storage image nodes with the storage object id', () => {
    const model = prosemirrorToFlightDeckContentModel({
      type: 'doc',
      content: [{
        type: 'fdStorageImage',
        attrs: {
          src: 'blob:http://localhost/transient-preview',
          objectId: 'pasted-image-123',
          alt: 'Pasted image',
        },
      }],
    });

    expect(model.content).toBe('![Pasted image](storage://pasted-image-123)');
    expect(model.content).not.toContain('blob:http://localhost');
  });

  it('does not export transient rich upload placeholders', () => {
    const model = prosemirrorToFlightDeckContentModel({
      type: 'doc',
      content: [{
        type: 'fdUploadPlaceholder',
        attrs: {
          uploadId: 'upload-1',
          label: 'Uploading image...',
        },
      }],
    });

    expect(model.content).toBe('');
    expect(model.content_blocks).toEqual([]);
  });

  it('round-trips rich ordered-list items without accumulating Markdown escapes', () => {
    const source = [
      '1. **Uncertainty:** Sentence ending with punctuation.',
      '2. **Path:** Keep C:\\docs\\draft.md and literal \\*asterisks\\*.',
      '3. **Marks:** _italic_, ~~strike~~, `code`, [link](https://example.com), and @[Operator A](mention:person:npub1operator-a).',
    ].join('\n');
    const contentBlocks = [{ id: 'ordered-list-a', type: 'list', text: source }];

    const imported = markdownToProseMirrorDoc(source, { contentBlocks });
    const listItems = imported.content[0].content;
    const boldPrefix = listItems[0].content[0].content[0];
    expect(boldPrefix).toMatchObject({
      type: 'text',
      text: 'Uncertainty:',
      marks: [{ type: 'bold' }],
    });

    const first = prosemirrorToFlightDeckContentModel(imported);
    expect(first.content).toContain('**Uncertainty:** Sentence ending with punctuation\\.');
    expect(first.content).not.toContain('\\*\\*Uncertainty');
    expect(first.content).toContain('C:\\\\docs\\\\draft\\.md');
    expect(first.content).toContain('~~strike~~');
    expect(first.content).toContain('`code`');
    expect(first.content).toContain('[link](https://example.com)');
    expect(first.content).toContain('@[Operator A](mention:person:npub1operator-a)');
    expect(first.content_blocks).toEqual([expect.objectContaining({
      id: 'ordered-list-a',
      type: 'list',
      text: first.content,
    })]);

    let canonical = first;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const reopened = markdownToProseMirrorDoc(canonical.content, {
        contentBlocks: canonical.content_blocks,
      });
      const next = prosemirrorToFlightDeckContentModel(reopened);
      expect(next.content).toBe(first.content);
      expect(next.content_blocks).toEqual(first.content_blocks);
      canonical = next;
    }
  });

  it('preserves rich marks in task and nested list-item block tokens', () => {
    const source = [
      '- [x] **Done:** keep _detail_ and ~~old wording~~.',
      '- [ ] **Todo:**',
      '  1. Follow [the plan](https://example.com/plan).',
    ].join('\n');

    const model = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(source));

    expect(model.content).toContain('- [x] **Done:** keep _detail_ and ~~old wording~~\\.');
    expect(model.content).toContain('- [ ] **Todo:**');
    expect(model.content).toContain('1. Follow [the plan](https://example.com/plan)\\.');
  });

  it('keeps a representative 26,706-character document tail stable across four rich-editor cycles', () => {
    const source = buildSyntheticLongDocumentFixture();
    expect(source).toHaveLength(SYNTHETIC_LONG_DOCUMENT_LENGTH);
    expect(source).not.toContain('\\');

    const first = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(source));
    const firstEscapeCount = (first.content.match(/\\/g) || []).length;
    expect(first.content).toContain('## 12\\-month implementation timeline');
    expect(first.content).toContain('TAIL\\_SENTINEL: synthetic\\-long\\-document\\-complete');
    expect(validateDocumentContentModelRoundTrip(first)).toEqual({ ok: true });

    let canonical = first;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const reopened = markdownToProseMirrorDoc(canonical.content, {
        contentBlocks: canonical.content_blocks,
      });
      const next = prosemirrorToFlightDeckContentModel(reopened);
      expect(next.content).toBe(first.content);
      expect(next.content_blocks).toEqual(first.content_blocks);
      expect((next.content.match(/\\/g) || []).length).toBe(firstEscapeCount);
      expect(next.content).toContain('TAIL\\_SENTINEL: synthetic\\-long\\-document\\-complete');
      expect(validateDocumentContentModelRoundTrip(next)).toEqual({ ok: true });
      canonical = next;
    }
  });

  it('detects a serializer result that silently drops the document tail', () => {
    const full = prosemirrorToFlightDeckContentModel(markdownToProseMirrorDoc(buildSyntheticLongDocumentFixture()));
    const partialState = {
      ...full.editor_state,
      content: full.editor_state.content.slice(0, 12),
    };
    const partial = prosemirrorToFlightDeckContentModel(partialState);
    const lossy = {
      ...full,
      content: partial.content,
      content_blocks: partial.content_blocks,
    };

    expect(validateDocumentContentModelRoundTrip(lossy)).toMatchObject({
      ok: false,
      reason: 'semantic_content_mismatch',
    });
  });
});

describe('prose boundary integrity', () => {
  const text = (value, marks = []) => ({ type: 'text', text: value, marks });
  const model = (content) => prosemirrorToFlightDeckContentModel({ type: 'doc', content });
  const paragraph = (content) => ({ type: 'paragraph', content });
  it('preserves ordinary prose tails and marked punctuation alongside trimmed list tails on forced reopen', () => {
    const state = { type: 'doc', content: [
      paragraph([text('Ordinary prose. ')]),
      paragraph([text('Next soft\nline. ')]),
      paragraph([text('Marked-word', [{ type: 'bold' }]), text(' and a tail. ')]),
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        paragraph([text('Label-word:', [{ type: 'bold' }]), text(' List prose. ')]),
      ] }] },
    ] };
    const snapshot = structuredClone(state);
    let current = createDocumentEditorState({ editor_state: state }).contentModel;
    const markdown = current.content;
    for (let cycle = 0; cycle < 6; cycle++) {
      expect(validateDocumentContentModelRoundTrip(current)).toEqual({ ok: true });
      expect(current.content).toBe(markdown);
      current = createDocumentEditorState({ ...current, editor_state: null }).contentModel;
    }
    expect(state).toEqual(snapshot);
  });
  it.each(['bold', 'italic', 'strike', 'code', 'link'])('serializes adjacent %s fragments as one run without changing the input', (type) => {
    const marks = [{ type, ...(type === 'link' ? { attrs: { href: 'https://example.com' } } : {}) }];
    const state = { type: 'doc', content: [paragraph(['left', '-', 'right'].map(value => text(value, marks)))] };
    const snapshot = structuredClone(state);
    let current = createDocumentEditorState({ editor_state: state }).contentModel;
    const markdown = current.content;
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(validateDocumentContentModelRoundTrip(current)).toEqual({ ok: true });
      expect(current.content).toBe(markdown);
      current = createDocumentEditorState({ ...current, editor_state: null }).contentModel;
    }
    expect(state).toEqual(snapshot);
  });
  it('accepts single trailing list prose spaces over repeated edit/save/reopen cycles', () => {
    let current = model([{ type: 'bulletList', content: ['First prose item. ', 'Second prose item. '].map(value => ({ type: 'listItem', content: [paragraph([text(value)])] })) }]);
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(validateDocumentContentModelRoundTrip(current)).toEqual({ ok: true });
      current = model(markdownToProseMirrorDoc(current.content, { contentBlocks: current.content_blocks }).content);
    }
    const edited = model([paragraph([text('Intentional replacement')])]);
    expect(validateDocumentContentModelRoundTrip(edited)).toEqual({ ok: true });
    expect(validateDocumentContentModelRoundTrip(model([]))).toEqual({ ok: true });
  });
  it.each([
    [paragraph([text('prose. ')]), paragraph([text('prose.')])],
    [paragraph([text('soft\nline')]), paragraph([text('softline')])],
    [paragraph([text('word '), text('next', [{ type: 'bold' }])]), paragraph([text('word'), text('next', [{ type: 'bold' }])])],
    [{ type: 'heading', attrs: { level: 2 }, content: [text('Heading ')] }, { type: 'heading', attrs: { level: 2 }, content: [text('Heading')] }],
    [paragraph([text('two words')]), paragraph([text('twowords')])],
    [paragraph([text('linked', [{ type: 'link', attrs: { href: 'https://example.com' } }])]), paragraph([text('linked')])],
    [paragraph([text('bold', [{ type: 'bold' }])]), paragraph([text('bold')])],
    [paragraph([text('linked', [{ type: 'link', attrs: { href: 'https://example.com/a' } }])]), paragraph([text('linked', [{ type: 'link', attrs: { href: 'https://example.com/b' } }])])],
    [paragraph([text('a'), { type: 'hardBreak' }, text('b')]), paragraph([text('ab')])],
    [{ type: 'codeBlock', content: [text(' a  b ')] }, { type: 'codeBlock', content: [text('a b')] }],
    [paragraph([text(' a ', [{ type: 'code' }])]), paragraph([text('a', [{ type: 'code' }])])],
    [paragraph([{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'A' } }]), paragraph([])],
  ])('rejects semantic loss %#', (original, damaged) => {
    const expected = model([original]);
    const actual = model([damaged]);
    expect(validateDocumentContentModelRoundTrip({ ...actual, editor_state: expected.editor_state }).ok).toBe(false);
  });
  it.each([
    [text('marked ', [{ type: 'bold' }])],
    [text('two spaces  ')],
    [text('tab\t')],
    [text('nonbreaking\u00a0')],
    [text('before break '), { type: 'hardBreak' }, text('after')],
  ].map(content => [content]))('does not excuse other list whitespace loss %#', (content) => {
    const wrap = (inline) => [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(inline)] }] }];
    const expected = model(wrap(content));
    const damaged = model(wrap(content.map(node => node.type === 'text' ? { ...node, text: node.text.trimEnd() } : node)));
    expect(validateDocumentContentModelRoundTrip({ ...damaged, editor_state: expected.editor_state }).ok).toBe(false);
  });
});

describe('editable whitespace serialization', () => {
  it('preserves italic flanking when a word is inserted directly beside marked punctuation', () => {
    for (const marks of [[{ type: 'italic' }], [{ type: 'bold' }, { type: 'italic' }]]) {
      const original = { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'edited' },
        { type: 'text', text: '“Quotation”', marks },
        { type: 'text', text: 'tail' },
      ] }] };
      let model = createDocumentEditorState({ editor_state: original }).contentModel;
      for (let cycle = 0; cycle < 4; cycle++) {
        expect(validateDocumentContentModelRoundTrip({ ...model, editor_state: original })).toEqual({ ok: true });
        model = createDocumentEditorState({ ...model, editor_state: null }).contentModel;
      }
    }
  });
  it('preserves rich pasted breaks, underline and shared italic across saves and edits', () => {
    const original = richBreakDocumentFixture();
    const snapshot = structuredClone(original);
    let model = createDocumentEditorState({ editor_state: original }).contentModel;
    const markdown = model.content;
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(validateDocumentContentModelRoundTrip({ ...model, editor_state: original })).toEqual({ ok: true });
      expect(model.content).toBe(markdown);
      expect(createDocumentEditorState(JSON.parse(JSON.stringify(model))).editorState).toEqual(model.editor_state);
      model = createDocumentEditorState({ ...model, editor_state: null }).contentModel;
    }
    expect(original).toEqual(snapshot);
    const edited = structuredClone(original);
    edited.content.at(-1).content[0].text = 'Meaningfully revised conclusion';
    const saved = createDocumentEditorState({ editor_state: edited }).contentModel;
    expect(validateDocumentContentModelRoundTrip(saved)).toEqual({ ok: true });
    expect(documentEditorSemanticTokens(createDocumentEditorState({ ...saved, editor_state: null }).editorState))
      .toEqual(documentEditorSemanticTokens(edited));
    for (const content of [saved.content.replace('<br>', ''), saved.content.replace(/<\/?u>/g, ''), saved.content.slice(0, 20)]) {
      expect(validateDocumentContentModelRoundTrip({ ...saved, content }).ok).toBe(false);
    }
  });
  it.each(['\u00a0', '\t', '\u2003', '\u202f', '\n'])('retains rich boundary whitespace %j in headings, marked prose and lists', (space) => {
    const inline = [{ type: 'text', text: `${space}Label:${space}`, marks: [{ type: 'bold' }] }];
    const state = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: `Heading${space}` }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }, ...inline, { type: 'text', text: 'After' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: inline }] }] },
    ] };
    let current = prosemirrorToFlightDeckContentModel(state);
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(validateDocumentContentModelRoundTrip({ ...current, editor_state: state })).toEqual({ ok: true });
      current = createDocumentEditorState({ ...current, editor_state: null }).contentModel;
    }
  });

  it.each(['bold', 'italic', 'strike'])('preserves %s boundary spaces and marks across repeated reopens', (type) => {
    const state = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Before ' },
      { type: 'text', text: ' Label: ', marks: [{ type }] },
      { type: 'text', text: ' after.' },
    ] }] };
    let current = prosemirrorToFlightDeckContentModel(state);
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(validateDocumentContentModelRoundTrip(current)).toEqual({ ok: true });
      const parsed = markdownToProseMirrorDoc(current.content);
      expect(parsed.content[0].content).toContainEqual({ type: 'text', text: ' Label: ', marks: [{ type }] });
      current = prosemirrorToFlightDeckContentModel(parsed);
    }
    expect(state.content[0].content[1].text).toBe(' Label: ');
  });

  it.each(['heading', 'paragraph', 'listItem'])('preserves exact %s boundary spaces, including escaped punctuation fragments', (type) => {
    const prose = { type: type === 'heading' ? 'heading' : 'paragraph', attrs: { level: 2 }, content: [
      { type: 'text', text: '  Boundary.  ' },
    ] };
    const state = { type: 'doc', content: [type === 'listItem'
      ? { type: 'bulletList', content: [{ type: 'listItem', content: [prose] }] } : prose] };
    let model = prosemirrorToFlightDeckContentModel(state);
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
      const damaged = { ...model, content: model.content.replace('&#32;', '') };
      expect(validateDocumentContentModelRoundTrip(damaged).ok).toBe(false);
      model = createDocumentEditorState({ ...model, editor_state: null }).contentModel;
    }
  });

  it.each(['bold', 'italic', 'strike'])('preserves %s marked spaces immediately beside unmarked words', (type) => {
    const state = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Before' },
      { type: 'text', text: ' Label: ', marks: [{ type }] },
      { type: 'text', text: 'After' },
    ] }] };
    let model = prosemirrorToFlightDeckContentModel(state);
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
      model = createDocumentEditorState({ ...model, editor_state: null }).contentModel;
    }
  });

  it('keeps literal entity-looking prose and inline/fenced code literal', () => {
    const state = { type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'Literal &#32; &amp; &#38; ' },
        { type: 'text', text: '&#32;', marks: [{ type: 'code' }] },
      ] },
      { type: 'codeBlock', content: [{ type: 'text', text: ' &#32; ' }] },
    ] };
    let model = prosemirrorToFlightDeckContentModel(state);
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(validateDocumentContentModelRoundTrip(model)).toEqual({ ok: true });
      model = createDocumentEditorState({ ...model, editor_state: null }).contentModel;
    }
  });

  it('rejects even single list tail-space loss now that serialization preserves it', () => {
    const model = createDocumentEditorState({ content: '- Tail.&#32;' }).contentModel;
    expect(validateDocumentContentModelRoundTrip({ ...model, content: '- Tail.' }).ok).toBe(false);
  });
});
