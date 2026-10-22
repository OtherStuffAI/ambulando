import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_REFERENCE_UNAVAILABLE, canvasNapletReference, canvasReferenceTarget, canvasReferenceUrl, centredViewport,
  copyCanvasReference, findReferenceWorkspace, parseCanvasReference,
} from '../src/canvas/references.js';
import { normalizeWorkspaceEntry } from '../src/workspaces.js';

const WS = '11111111-1111-4111-8111-111111111111';
const CANVAS = '22222222-2222-4222-8222-222222222222';
const NAPLET = '33333333-3333-4333-8333-333333333333';
const origin = 'https://deck.example';
const ready = { id: NAPLET, access: 'ready', title: 'Release [draft] plan', source: { type: 'excalidraw', id: 'secret-file' }, layout: { x: 100, y: 200, width: 400, height: 300, z: 1 } };

describe('canvas naplet references', () => {
  it('builds a Markdown link and full URL from Tower ids only', () => {
    const reference = canvasNapletReference({ origin, workspaceId: WS, canvas: { canvas_id: CANVAS, title: 'Roadmap' }, naplet: ready });
    expect(reference.url).toBe(`${origin}/canvas.html?workspaceid=${WS}&canvasid=${CANVAS}&napletid=${NAPLET}`);
    expect(reference.markdown).toBe(`[Release \\[draft\\] plan · Roadmap](${reference.url})`);
    // No local workspace key, session, token or source identity.
    expect(reference.url).not.toMatch(/workspacekey|token|secret-file|excalidraw|npub/);
  });

  it('offers no reference for restricted placeholders or incomplete identities', () => {
    const canvas = { canvas_id: CANVAS, title: 'Roadmap' };
    expect(canvasNapletReference({ origin, workspaceId: WS, canvas, naplet: { id: NAPLET, access: 'denied', title: 'Protected' } })).toBeNull();
    expect(canvasNapletReference({ origin, workspaceId: '', canvas, naplet: ready })).toBeNull();
    expect(canvasNapletReference({ origin: 'javascript:alert(1)', workspaceId: WS, canvas, naplet: ready })).toBeNull();
    expect(canvasReferenceUrl({ origin, workspaceId: WS, canvasId: CANVAS, napletId: '"><script>' })).toBe('');
  });

  it('parses canonical, legacy and malformed links without echoing bad ids', () => {
    expect(parseCanvasReference(`?workspaceid=${WS}&canvasid=${CANVAS}&napletid=${NAPLET}`)).toEqual({ workspaceId: WS, workspaceIdMalformed: false, workspaceKey: '', canvasId: CANVAS, napletId: NAPLET, napletRequested: true });
    expect(parseCanvasReference(`?workspacekey=pg%3Akey&canvasid=${CANVAS}`)).toMatchObject({ workspaceId: '', workspaceKey: 'pg:key', napletId: '', napletRequested: false });
    expect(parseCanvasReference(`?workspaceid=${WS}&canvasid=${CANVAS}&napletid=<img src=x>`)).toMatchObject({ napletId: '', napletRequested: true });
    expect(parseCanvasReference('?workspaceid=../../x&canvasid=c')).toMatchObject({ workspaceId: '', workspaceIdMalformed: true });
  });

  it('matches a workspace by Tower id across local workspace keys, never another identity', () => {
    const entry = (npub, extra = {}) => normalizeWorkspaceEntry({ workspaceId: WS, workspaceOwnerNpub: 'npub1owner', pgSessionNpub: npub, directHttpsUrl: 'https://tower.example', appNpub: 'npub1app', towerServiceNpub: 'npub1tower', workspaceServiceNpub: 'npub1ws', pgBackendMode: true, ...extra });
    const mine = entry('npub1me'), theirs = entry('npub1other');
    expect(mine.workspaceKey).not.toBe(theirs.workspaceKey);
    expect(findReferenceWorkspace([theirs, mine], { workspaceId: WS, sessionNpub: 'npub1me' })).toBe(mine);
    expect(findReferenceWorkspace([theirs], { workspaceId: WS, sessionNpub: 'npub1me' })).toBeNull();
    expect(findReferenceWorkspace([mine], { workspaceId: '44444444-4444-4444-8444-444444444444', sessionNpub: 'npub1me' })).toBeNull();
    // Ordinary links keep resolving by local key or id.
    expect(findReferenceWorkspace([theirs, mine], { workspaceKey: mine.workspaceKey })).toBe(mine);
  });

  it('selects only readable targets; missing and restricted look the same', () => {
    const denied = { id: 'restricted', access: 'denied', layout: ready.layout };
    expect(canvasReferenceTarget([ready, denied], NAPLET)).toBe(ready);
    expect(canvasReferenceTarget([ready, denied], 'restricted')).toBeNull();
    expect(canvasReferenceTarget([ready], 'missing')).toBeNull();
    expect(canvasReferenceTarget([ready], '')).toBeNull();
    expect(CANVAS_REFERENCE_UNAVAILABLE).not.toMatch(/restricted|denied|exists/i);
  });

  it('centres a target in the stage at the current zoom', () => {
    expect(centredViewport(ready.layout, { width: 1000, height: 800 }, { x: -5000, y: 9000, scale: 1 })).toEqual({ x: 200, y: 50, scale: 1 });
    expect(centredViewport(ready.layout, { width: 1000, height: 800 }, { scale: 0.5 })).toEqual({ x: 350, y: 225, scale: 0.5 });
    // Wider than a phone stage: zoomed out (viewer-local) to fit, then centred; never zoomed in.
    const phone = centredViewport(ready.layout, { width: 390, height: 700 }, { scale: 1 });
    expect(phone.scale).toBeCloseTo(342 / 400, 5);
    expect(phone).toMatchObject({ x: -61, y: 51 });
    expect(100 * phone.scale + phone.x).toBeGreaterThanOrEqual(24);
    expect((100 + 400) * phone.scale + phone.x).toBeLessThanOrEqual(390 - 23);
    expect(centredViewport(ready.layout, { width: 4000, height: 4000 }, { scale: 0.5 }).scale).toBe(0.5);
    // Too large even at the minimum zoom: the title bar stays in view.
    expect(centredViewport({ x: 0, y: 0, width: 1200, height: 1000 }, { width: 200, height: 160 }, { scale: 1 })).toEqual({ x: 24, y: 24, scale: 0.2 });
  });

  it('reports clipboard failure honestly instead of claiming success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyCanvasReference('[x](y)', { writeText })).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('[x](y)');
    expect(await copyCanvasReference('[x](y)', { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) })).toEqual({ ok: false, reason: 'denied' });
    expect(await copyCanvasReference('[x](y)', undefined)).toEqual({ ok: false, reason: 'unsupported' });
    expect(await copyCanvasReference('', { writeText })).toEqual({ ok: false, reason: 'unavailable' });
  });
});
