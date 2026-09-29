// Isolated real-browser component replay; no app server, Tower, or network writes.
// Optional private envelopes remain on disk outside the repository. Output is counts/hashes only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { richBreakDocumentFixture } from '../tests/fixtures/rich-break-document.js';

const bundle = await build({
  stdin: {
    contents: `export * from './src/docs/editor/tiptap-editor-adapter.js';
      export * from './src/docs/editor/document-content-integrity.js';
      export * from './src/docs/editor/markdown-to-prosemirror.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'iife', globalName: 'documentReplay',
});
const inputs = [{
  label: 'synthetic',
  content_model: { content: '# Heading\n\n**Label:** ordinary prose.\n\n- **Item:** tail.\n\nLiteral \\&#32; and `&#32;`.\n\nFinal retained paragraph.' },
}, { label: 'synthetic-rich-breaks', content_model: { editor_state: richBreakDocumentFixture() } }, ...process.argv.slice(2).filter((arg) => arg !== '--sweep').map((path) => {
  const bytes = readFileSync(path);
  const envelope = JSON.parse(bytes);
  assert(envelope.content_model, 'Expected an envelope with content_model');
  return { label: createHash('sha256').update(bytes).digest('hex'), content_model: envelope.content_model };
})];
const browser = await chromium.launch({ headless: true, channel: process.env.DOCUMENT_REPLAY_BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<div id="editor"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const input of inputs) {
    await page.evaluate((model) => {
      window.adapter?.destroy();
      window.adapter = documentReplay.createTiptapEditorAdapter({ element: document.querySelector('#editor'), document: model });
      window.baseline = adapter.getJSON();
      if (!documentReplay.validateDocumentContentModelRoundTrip(adapter.getContentModel()).ok) {
        throw new Error('Unedited browser save rejected');
      }
      // The real input transaction inherits bold at the right edge of a label.
      let end = null;
      adapter.editor.state.doc.descendants((node, pos) => {
        if (end === null && node.isText && node.marks.some((mark) => mark.type.name === 'bold')) end = pos + node.nodeSize;
      });
      if (end === null) throw new Error('Fixture needs a bold text run');
      adapter.editor.view.focus();
      adapter.editor.commands.setTextSelection(end);
    }, input.content_model);
    await page.keyboard.type(' ');
    const result = await page.evaluate(({ sweep }) => {
      const { documentEditorSemanticTokens: tokens, validateDocumentContentModelRoundTrip: validate, markdownToProseMirrorDoc: parse } = documentReplay;
      const equal = (a, b) => JSON.stringify(tokens(a)) === JSON.stringify(tokens(b));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const edited = adapter.getJSON();
      check(!equal(edited, baseline), 'Keyboard edit must change the document');
      let cycles = 0;
      for (const forceMarkdown of [false, true]) {
        adapter.setContent(edited);
        for (let cycle = 0; cycle < 8; cycle++) {
          const saved = adapter.getContentModel();
          check(validate(saved).ok, 'Browser save rejected');
          // Model the JSON storage envelope, then destroy/remount the component.
          const stored = JSON.parse(JSON.stringify(saved));
          if (forceMarkdown) stored.editor_state = null;
          adapter.destroy();
          window.adapter = documentReplay.createTiptapEditorAdapter({ element: document.querySelector('#editor'), document: stored });
          check(equal(edited, adapter.getJSON()), 'Browser reopen lost semantic content');
          cycles++;
        }
      }
      const saved = adapter.getContentModel();
      check(!validate({ ...saved, content: saved.content.slice(0, Math.floor(saved.content.length / 2)) }).ok, 'Truncation was not rejected');
      const deleted = JSON.parse(JSON.stringify(edited));
      do { deleted.content.pop(); } while (deleted.content.length && equal(deleted, edited));
      adapter.setContent(deleted);
      const smaller = adapter.getContentModel();
      check(validate(smaller).ok, 'Intentional deletion rejected');
      check(!validate({ ...smaller, editor_state: edited }).ok, 'Unintended deletion accepted');
      check(equal(deleted, parse(smaller.content)), 'Intentional deletion failed Markdown reopen');
      let editChecks = 0;
      if (sweep) {
        adapter.setContent(baseline);
        const positions = new Set();
        adapter.editor.state.doc.descendants((node, pos) => { if (node.isText) { positions.add(pos); positions.add(pos + node.nodeSize); } });
        for (const pos of positions) for (const text of [' ', ' edited', 'x']) {
          adapter.setContent(baseline);
          adapter.editor.commands.setTextSelection(pos);
          adapter.editor.commands.insertContent(text);
          check(validate(adapter.getContentModel()).ok, `Boundary edit rejected at position ${pos}`);
          editChecks++;
        }
      }
      return { uneditedSave: true, keyboardEdit: true, browserReopens: cycles, intentionalDeletion: true, rejectedLosses: 2, boundaryEditChecks: editChecks };
    }, { sweep: process.argv.includes('--sweep') });
    console.log(JSON.stringify({ fixture: input.label, ...result }));
  }
} finally {
  await browser.close();
}
