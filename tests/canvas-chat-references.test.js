// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools';
import { CanvasReferenceCatalog, canvasChatReference, canvasChatProjection, canvasChatSuggestions, withCanvasChatOrigin, parseCanvasChatReference } from '../src/canvas/chat-references.js';
import { hydrateMentionComposer, serializeMentionComposerState } from '../src/mention-composer.js';
import { renderMarkdownToHtml } from '../src/markdown.js';
import { buildAgentInstructionSignature } from '../src/message-instruction-signatures.js';
import { parseCanvasReference } from '../src/canvas/references.js';
const origin = 'https://example.test', workspaceId = 'workspace';
const current = { workspaceId, canvasId: 'one', title: 'Delivery map', items: [] };
const ref = extra => canvasChatReference({ origin, workspaceId, canvasId: 'one', title: 'Delivery map', ...extra });

describe('Canvas signed message references', () => {
  it('gives each send its own visible origin without inheriting thread context', () => {
    const first = withCanvasChatOrigin('First', current, origin, workspaceId);
    const reply = withCanvasChatOrigin('Reply', current, origin, workspaceId);
    const second = withCanvasChatOrigin('Reply', { ...current, canvasId: 'two', title: 'Other Canvas' }, origin, workspaceId);
    expect(first).toContain('[From: Delivery map](');
    expect(withCanvasChatOrigin(first, current, origin, workspaceId)).toBe(first);
    expect(reply).toContain('canvasid=one'); expect(second).toContain('canvasid=two');
    expect(withCanvasChatOrigin('Outside', null, origin, workspaceId)).toBe('Outside');
    expect(withCanvasChatOrigin('Outside', current, origin, 'other-workspace')).toBe('Outside');
    const other = ref({ canvasId: 'other', title: 'Other Canvas' });
    expect(withCanvasChatOrigin(other.token, current, origin, workspaceId)).toContain(other.token);
  });
  it('resolves bare canvas, colon, aliases and names with spaces', () => {
    const canvases = [{ canvas_id: 'one', title: 'Delivery map' }, { canvas_id: 'brand', title: 'Ambulando brand' }];
    for (const query of ['canvas', 'canvas:', 'canvas:this', 'canvas:thiscanvas', 'canvas:this canvas']) {
      expect(canvasChatSuggestions(query, canvases, current, origin, workspaceId)[0].label).toBe('This Canvas');
    }
    expect(canvasChatSuggestions('canvas:Ambulando br', canvases, current, origin, workspaceId).map(row => row.id)).toEqual(['brand']);
    expect(canvasChatSuggestions('Canvas Agent', canvases, current, origin, workspaceId)).toEqual([]);
    expect(canvasChatSuggestions('canvas:', [], current, origin, 'other')).toEqual([]);
  });
  it('projects ready items only and keeps displayed versions without source content', () => {
    const store = { status: 'ready', currentWorkspace: { workspaceId }, canvasId: 'one', canvas: { title: 'Map' }, naplets: [
      { id: 'artifact', title: 'Brand page', access: 'ready', source: { type: 'html', id: 'file' }, content: { html: 'PRIVATE_BYTES', version_id: 'v1', version_number: 1 } },
      { id: 'denied', title: 'SECRET', access: 'denied' },
    ], htmlContent: () => ({ version_id: 'v2', version_number: 2, html: 'PRIVATE_BYTES' }) };
    const projection = canvasChatProjection(store, origin);
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0].url).toContain('versionid=v2');
    expect(JSON.stringify(projection)).not.toMatch(/PRIVATE_BYTES|SECRET/);
    expect(canvasChatSuggestions('canvas:brand page', [], projection, origin, workspaceId)[0].sublabel).toBe('Item on this Canvas');
    store.status = 'error'; expect(canvasChatProjection(store, origin)).toBeNull();
  });
  it('restores clickable versioned reference chips from drafts/reload without agent routing', () => {
    const item = ref({ napletId: 'item', sourceId: 'file', versionId: 'version-7', title: 'Brand [page] · v7' });
    const root = document.createElement('div');
    hydrateMentionComposer(root, `Inspect ${item.token}`);
    const pill = root.querySelector('a');
    expect(pill.href).toBe(item.url); expect(pill.contentEditable).toBe('false');
    expect(serializeMentionComposerState(root)).toEqual({ value: `Inspect ${item.token}`, actorMentions: [] });
    const html = renderMarkdownToHtml(item.token);
    expect(html).toContain('data-canvas-reference="true"'); expect(html).toContain('versionid=version-7');
    expect(parseCanvasReference(new URL(item.url).search)).toMatchObject({ napletId: 'item', sourceId: 'file', versionId: 'version-7' });
    expect(parseCanvasChatReference('javascript:alert(1)')).toBeNull();
    expect(parseCanvasChatReference('https://example.test/canvas.html?workspaceid=workspace')).toBeNull();
  });
  it('signs exact readable origin and reference URLs, making changes invalidate the proof', async () => {
    const body = withCanvasChatOrigin(`Inspect ${ref({ napletId: 'item', versionId: 'v3' }).token}`, current, origin, workspaceId);
    const key = generateSecretKey();
    const signature = await buildAgentInstructionSignature({ body, workspaceId, channelId: 'channel', threadId: 'thread' }, event => finalizeEvent(event, key));
    expect(verifyEvent(signature.nostr_event)).toBe(true);
    expect(signature.nostr_event.content).toBe(body);
    const tampered = { ...JSON.parse(JSON.stringify(signature.nostr_event)), content: body.replace('canvasid=one', 'canvasid=two') };
    expect(verifyEvent(tampered)).toBe(false);
  });
});

it('coalesces list queries within the viewer partition and drops old identity results', async () => {
  const catalog = new CanvasReferenceCatalog();
  let finish;
  const first = catalog.read('workspace-one:viewer', () => new Promise(resolve => { finish = resolve; }));
  expect(catalog.read('workspace-one:viewer', () => { throw new Error('duplicate fetch'); })).toBe(first);
  await Promise.resolve();
  const other = catalog.read('workspace-two:viewer', () => [{ canvas_id: 'two' }]);
  finish([{ canvas_id: 'one' }]);
  expect(await other).toEqual([{ canvas_id: 'two' }]);
  expect(await first).toEqual([{ canvas_id: 'one' }]);
  expect(await catalog.read('workspace-two:viewer', () => { throw new Error('duplicate'); })).toEqual([{ canvas_id: 'two' }]);
});
