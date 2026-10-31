import { describe, expect, it } from 'vitest';
import { threeWayMerge, reviewDocumentChanges } from '../src/docs/three-way-merge.js';

const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...text) => ({ title: 'A document', editor_state: { type: 'doc', content: text.map(paragraph) } });

describe('common-base rich document merge', () => {
  it('combines independent local and latest paragraphs from v6 without losing structure', () => {
    const result = threeWayMerge(doc('one', 'two'), doc('my one', 'two'), doc('one', 'their two'));
    expect(result.unresolved).toBe(0);
    expect(result.value).toEqual(doc('my one', 'their two'));
  });
  it('combines independent edits inside the same paragraph', () => {
    expect(threeWayMerge(doc('hello world'), doc('Hello world'), doc('hello world!')).value).toEqual(doc('Hello world!'));
  });
  it('requires explicit choice for overlapping replacements and reproduces either choice', () => {
    const input = [doc('same old body'), doc('my new body'), doc('their new body')];
    const first = threeWayMerge(...input);
    expect(first.unresolved).toBeGreaterThan(0);
    const resolutions = Object.fromEntries(first.conflicts.map(c => [c.id, 'latest']));
    expect(threeWayMerge(...input, resolutions).unresolved).toBe(0);
    expect(threeWayMerge(...input, resolutions).value).toEqual(input[2]);
  });
  it('preserves rich marks, links, tables and attachments while combining separate edits', () => {
    const base = doc('hello', 'other');
    base.editor_state.content.push({ type: 'image', attrs: { src: 'storage://image', alt: 'original' } });
    const local = structuredClone(base), remote = structuredClone(base);
    local.editor_state.content[0].content[0].marks = [{ type: 'bold' }];
    remote.editor_state.content[1].content[0].text = 'remote';
    remote.editor_state.content[2].attrs.alt = 'remote image';
    const result = threeWayMerge(base, local, remote);
    expect(result.unresolved).toBe(0);
    expect(result.value.editor_state.content[0]).toEqual(local.editor_state.content[0]);
    expect(result.value.editor_state.content.slice(1)).toEqual(remote.editor_state.content.slice(1));
  });
  it('does not conflate identical independently added content or deletion vs modification', () => {
    expect(threeWayMerge(['a'], ['a', 'b'], ['a', 'b'])).toMatchObject({ value: ['a', 'b'], unresolved: 0 });
    expect(threeWayMerge(['a'], [], ['changed']).unresolved).toBe(1);
  });
  it('combines independent insertions and adjacent replacements', () => {
    expect(threeWayMerge(['a', 'b'], ['A', 'b'], ['a', 'B'])).toMatchObject({ value: ['A', 'B'], unresolved: 0 });
    expect(threeWayMerge(['a', 'b', 'c'], ['x', 'a', 'b', 'c'], ['a', 'b', 'c', 'y']).value).toEqual(['x', 'a', 'b', 'c', 'y']);
  });
  it('never invents a base for a two-way review', () => {
    expect(reviewDocumentChanges({ localText: 'local', latestText: 'remote' })).not.toHaveProperty('value');
  });
  it('ignores editor IDs but treats whitespace and formatting exactly', () => {
    const base = { type: 'paragraph', attrs: { fdBlockId: 'base' }, text: 'x' };
    expect(threeWayMerge(base, { ...base, attrs: { fdBlockId: 'local' } }, { ...base, text: 'x ' })).toMatchObject({ value: { type: 'paragraph', attrs: { fdBlockId: 'base' }, text: 'x ' }, unresolved: 0 });
  });
  it('retains stable block identities for existing comment anchors across independent edits', () => {
    const base = doc('first', 'second');
    base.editor_state.content[0].attrs = { fdBlockId: 'first-anchor' };
    base.editor_state.content[1].attrs = { fdBlockId: 'second-anchor' };
    const local = structuredClone(base), remote = structuredClone(base);
    local.editor_state.content[0].content[0].text = 'my first';
    remote.editor_state.content[1].content[0].text = 'their second';
    const result = threeWayMerge(base, local, remote);
    expect(result.unresolved).toBe(0);
    expect(result.value.editor_state.content[0].attrs.fdBlockId).toBe('first-anchor');
    expect(result.value.editor_state.content[1].attrs.fdBlockId).toBe('second-anchor');
  });
  it('bounds expensive diffs and falls back to explicit resolution', () => {
    expect(threeWayMerge('a'.repeat(10000), 'b'.repeat(10000), 'c'.repeat(10000)).unresolved).toBe(1);
  });
});
