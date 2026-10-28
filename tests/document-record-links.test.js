// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@tiptap/pm/model';
import { createTiptapEditorAdapter } from '../src/docs/editor/tiptap-editor-adapter.js';
import { insertRecordLink, recordLinkRange } from '../src/docs/editor/record-link-extension.js';
import { markdownToProseMirrorDoc } from '../src/docs/editor/markdown-to-prosemirror.js';

let adapter;
afterEach(() => { adapter?.destroy(); adapter = null; document.body.replaceChildren(); });
function mount(content = '', options = {}) {
  const element = document.createElement('div'); document.body.append(element);
  adapter = createTiptapEditorAdapter({ element, document: { content }, ...options });
  return adapter;
}
const choices = [
  { type: 'doc', id: 'page-id', label: 'Page' },
  { type: 'task', id: 'task-id', label: 'Task' },
  { type: 'canvas', id: 'canvas-id', label: 'Canvas', url: '/canvas.html?workspaceid=workspace-id&canvasid=canvas-id' },
];
describe('document record links', () => {
  it.each(choices)('saves and reopens $type references with stable IDs and surrounding formatting', choice => {
    const updates = [];
    const a = mount('**Before** @target after [[Page]]', { onUpdate: model => updates.push(model) });
    const text = a.editor.state.doc.textContent;
    const from = text.indexOf('@target') + 1;
    expect(insertRecordLink(a.editor, { from, to: from + 7 }, choice)).toBe(true);
    const saved = a.getContentModel();
    expect(saved.content).toContain('**Before**');
    expect(saved.content).toContain('after [[Page]]');
    expect(saved.content).toContain(choice.url || `mention:${choice.type}:${choice.id}`);
    expect(updates.at(-1).content).toBe(saved.content);
    a.setContent(markdownToProseMirrorDoc(saved.content));
    expect(a.getContentModel().content).toBe(saved.content);
    if (choice.url) expect(a.editor.view.dom.querySelector('a').getAttribute('href')).toBe(choice.url);
    else expect(a.editor.view.dom.querySelector('[data-mention-id]').dataset.mentionId).toBe(choice.id);
  });
  it('undo and redo restore text and link without swallowing later typing', () => {
    const a = mount('@page');
    insertRecordLink(a.editor, { from: 1, to: 6 }, choices[0]);
    a.editor.commands.insertContent('continued');
    expect(a.getContentModel().content).toContain(') continued');
    a.editor.commands.undo();
    expect(a.getContentModel().content).toBe('@page');
    a.editor.commands.redo();
    expect(a.getContentModel().content).toContain('mention:doc:page-id');
  });
  it('retains mention identities through rich HTML copy/paste', () => {
    const a = mount('@[Page](mention:doc:page-id)');
    const html = document.createElement('div'); html.innerHTML = a.editor.getHTML();
    const pasted = DOMParser.fromSchema(a.editor.schema).parse(html).toJSON();
    expect(pasted.content[0].content[0].marks).toContainEqual(expect.objectContaining({ type: 'fdMention', attrs: expect.objectContaining({ mentionId: 'page-id', mentionType: 'doc' }) }));
  });
  it('ignores emails, code, selected text and existing references', () => {
    const a = mount('mail@example.com');
    a.editor.commands.setTextSelection(a.editor.state.doc.content.size - 1);
    expect(recordLinkRange(a.editor.state)).toBeNull();
    a.setContent(markdownToProseMirrorDoc('`@code`'));
    a.editor.commands.setTextSelection(4);
    expect(recordLinkRange(a.editor.state)).toBeNull();
    a.setContent(markdownToProseMirrorDoc('@page'));
    a.editor.commands.setTextSelection({ from: 1, to: 3 });
    expect(recordLinkRange(a.editor.state)).toBeNull();
  });
  it('ignores late asynchronous results after selection changes and supports keyboard choice', async () => {
    let resolve;
    const search = vi.fn(() => new Promise(done => { resolve = done; }));
    const a = mount('', { recordLinks: { search } });
    a.editor.view.coordsAtPos = () => ({ left: 10, bottom: 10 });
    a.editor.commands.insertContent('@page');
    await Promise.resolve();
    expect(search).toHaveBeenCalledWith('page', expect.any(Function));
    a.editor.commands.setTextSelection(1);
    resolve(choices);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.fd-record-link-picker').hidden).toBe(true);
    a.editor.commands.setTextSelection(6);
    await Promise.resolve();
    resolve(choices);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    a.editor.view.dom.dispatchEvent(event);
    expect(a.getContentModel().content).toContain('mention:doc:page-id');
    expect(document.querySelector('.fd-record-link-picker').hidden).toBe(true);
  });
});

it('activates Canvas only on an ordinary click, preserving selection drags and Shift', () => {
  const open = vi.fn();
  const a = mount('[Canvas](https://example.com/canvas.html?workspaceid=one&canvasid=canvas)', {
    recordLinks: { search: async () => [] }, onCanvasLink: open,
  });
  const link = a.editor.view.dom.querySelector('a');
  link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  expect(open).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  expect(open).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(open).toHaveBeenCalledOnce();
});


it('retains active formatting when replacing a typed reference', () => {
  const a = mount('**@page**');
  a.editor.commands.setTextSelection(6);
  insertRecordLink(a.editor, { from: 1, to: 6 }, choices[0]);
  expect(a.editor.getJSON().content[0].content[0].marks).toContainEqual({ type: 'bold' });
  expect(a.getContentModel().content).toContain('mention:doc:page-id');
});
