import { describe, expect, it, vi } from 'vitest';
import { EXIT_UNAVAILABLE, referenceIds, resolveReference, run } from '../scripts/canvas-reference.mjs';
import { TowerError } from '../scripts/html-artifact/tower.mjs';

const WS = '11111111-1111-4111-8111-111111111111';
const CANVAS = '22222222-2222-4222-8222-222222222222';
const BOARD = '33333333-3333-4333-8333-333333333333';
const RESTRICTED = '44444444-4444-4444-8444-444444444444';
const FILE = '55555555-5555-4555-8555-555555555555';
const url = (naplet = BOARD) => `https://deck.example/canvas.html?workspaceid=${WS}&canvasid=${CANVAS}&napletid=${naplet}`;
const snapshot = {
  canvas: { id: CANVAS, title: 'Roadmap' },
  naplets: [
    { id: BOARD, access: 'ready', title: 'Release plan', layout: { x: 1, y: 2, width: 640, height: 460, z: 1 }, source: { type: 'excalidraw', id: FILE } },
    { id: RESTRICTED, access: 'denied', title: 'Protected', layout: { x: 0, y: 0, width: 300, height: 200, z: 2 } },
  ],
};
const client = (response = snapshot) => ({ request: vi.fn(async () => { if (response instanceof Error) throw response; return response; }) });

describe('canvas reference CLI', () => {
  it('parses a reference URL or the copied Markdown link', () => {
    const ids = { origin: 'https://deck.example', workspace_id: WS, canvas_id: CANVAS, naplet_id: BOARD };
    expect(referenceIds(url())).toEqual(ids);
    expect(referenceIds(`[Release plan · Roadmap](${url()})`)).toEqual(ids);
    expect(() => referenceIds('https://deck.example/canvas.html?canvasid=x')).toThrow('Reference unavailable');
    expect(() => referenceIds('https://deck.example/tasks?workspaceid=x')).toThrow('Reference unavailable');
  });

  it('resolves the naplet and source from the authoritative snapshot', async () => {
    const tower = client();
    const result = await resolveReference(referenceIds(url()), tower);
    expect(tower.request).toHaveBeenCalledWith('GET', `/api/v4/flightdeck-pg/workspaces/${WS}/canvases/${CANVAS}/snapshot`);
    expect(result).toEqual({
      workspace_id: WS, canvas: { id: CANVAS, title: 'Roadmap' },
      naplet: { id: BOARD, title: 'Release plan', layout: snapshot.naplets[0].layout, source: { type: 'excalidraw', id: FILE, version_id: null } },
      next: `bun scripts/excalidraw-board.mjs read --file ${FILE} --out board.excalidraw`,
    });
  });

  it('reports missing, restricted, malformed and denied references with one neutral message', async () => {
    const outputs = [];
    const cases = [
      [url('66666666-6666-4666-8666-666666666666'), client()],
      [url(RESTRICTED), client()],
      [url(BOARD), client(new TowerError(403, 'forbidden', 'no'))],
      ['not a link', client()],
    ];
    for (const [reference, tower] of cases) {
      const err = vi.fn(), out = vi.fn();
      expect(await run(['resolve', '--url', reference], { out, err, clientFactory: () => tower })).toBe(EXIT_UNAVAILABLE);
      expect(out).not.toHaveBeenCalled();
      outputs.push(err.mock.calls[0][0]);
    }
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).not.toMatch(/Protected|denied|excalidraw/i);
  });

  it('parse works offline; other Tower failures are not disguised', async () => {
    const out = vi.fn();
    expect(await run(['parse', '--url', url()], { out, clientFactory: () => { throw new Error('no network'); } })).toBe(0);
    expect(JSON.parse(out.mock.calls[0][0]).naplet_id).toBe(BOARD);
    await expect(run(['resolve', '--url', url()], { out, err: vi.fn(), clientFactory: () => client(new TowerError(500, 'server', 'boom')) })).rejects.toThrow('500');
  });
});
