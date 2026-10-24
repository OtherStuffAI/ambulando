import { describe, expect, it } from 'vitest';
import { applyCommentOperation, boardComments, commentAnchor, commentDrawingContext, commentPosition, followCommentAnchors, normalizeBoardComments } from '../src/canvas/board-comments.js';
import { boardSceneFingerprint, createEmptyBoardScene, exportPublicBoardScene, parseBoardScene, rebaseBoardScene, restoreBoardScene, serializeBoardScene } from '../src/canvas/board-scene.js';
const shape = { id: 'shape', type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 100, height: 80, angle: 0 };
const empty = () => ({ ...createEmptyBoardScene(), elements: [shape] });
const comment = scene => applyCommentOperation(scene, { type: 'create', id: 'root', body: '<img onerror=alert(1)>', anchor: commentAnchor({ x: 25, y: 20 }, scene.elements) }, 'npub1human');
describe('board spatial discussion', () => {
  it('round trips separately from drawing and marks only discussion changes dirty', () => {
    const base = empty(), draft = comment(base);
    const saved = parseBoardScene(serializeBoardScene(draft).bytes);
    expect(boardComments(saved)).toEqual(boardComments(draft));
    expect(saved.elements).toEqual(base.elements);
    expect(boardSceneFingerprint(draft)).not.toBe(boardSceneFingerprint(base));
    expect(exportPublicBoardScene(draft).wingman).toBeUndefined();
    expect(boardComments(parseBoardScene(JSON.stringify(base)))).toEqual([]);
    expect(boardComments(parseBoardScene({ scene: draft }))).toHaveLength(1);
  });
  it('follows moved/resized/rotated shapes and freezes last coordinates on deletion', () => {
    const anchor = commentAnchor({ x: 25, y: 20 }, [shape]);
    expect(anchor).toMatchObject({ element_id: 'shape', u: .25, v: .25 });
    const moved = { ...shape, x: 300, y: 200, width: 200, height: 160, angle: Math.PI };
    expect(commentPosition(anchor, [moved])).toMatchObject({ x: 450, y: 320 });
    const [thread] = followCommentAnchors(boardComments(comment(empty())), [{ ...moved, isDeleted: true }]);
    expect(commentPosition(thread.anchor, [{ ...moved, isDeleted: true }])).toMatchObject({ x: 450, y: 320, detached: true });
    expect(commentPosition(thread.anchor, [])).toMatchObject({ x: 450, y: 320, detached: true });
    expect(commentAnchor({ x: 25, y: 20 }, [shape], false)).toEqual({ x: 25, y: 20 });
  });
  it('merges concurrent replies and drawing changes without losing either; reports divergent content', () => {
    const base = comment(empty());
    const draft = applyCommentOperation(base, { type: 'reply', thread_id: 'root', body: 'mine' }, 'npub1human');
    const latest = applyCommentOperation({ ...base, elements: [{ ...shape, x: 200, version: 2 }] }, { type: 'reply', thread_id: 'root', body: 'theirs' }, 'npub1agent');
    const result = rebaseBoardScene({ base, draft, latest });
    expect(boardComments(result.scene)[0].messages.map(m => m.body)).toEqual(['<img onerror=alert(1)>', 'theirs', 'mine']);
    expect(result.scene.elements[0].x).toBe(200);
    expect(result.conflicts).toEqual([]);
    const divergent = structuredClone(draft); divergent.wingman.comments[0].messages[0].body = 'changed';
    expect(rebaseBoardScene({ base, draft: divergent, latest }).conflicts).toHaveLength(1);
    expect(boardComments(restoreBoardScene({ target: empty(), latest }))[0].messages).toHaveLength(2);
    const closed = applyCommentOperation(latest, { type: 'resolve', thread_id: 'root', resolved: true }, 'npub1human');
    expect(boardComments(restoreBoardScene({ target: base, latest: closed }))[0].resolved).toBe(true);
  });
  it('validates payloads/identity and resolves/reopens without changing replies', () => {
    expect(() => applyCommentOperation(empty(), { type: 'create' }, '')).toThrow(/authenticated/);
    const base = comment(empty());
    const resolved = applyCommentOperation(base, { type: 'resolve', thread_id: 'root', resolved: true }, 'npub1human');
    expect(boardComments(resolved)[0].resolved).toBe(true);
    expect(boardComments(applyCommentOperation(resolved, { type: 'resolve', thread_id: 'root', resolved: false }, 'npub1human'))[0].resolved).toBe(false);
    expect(() => applyCommentOperation(base, { type: 'reply', thread_id: 'root', body: '' }, 'npub1human')).toThrow();
    expect(() => normalizeBoardComments([...boardComments(base), ...boardComments(base)])).toThrow(/duplicate/);
    expect(() => normalizeBoardComments([{ ...boardComments(base)[0], anchor: { x: Infinity, y: 0 } }])).toThrow(/anchor/);
  });
  it('reads attached, nearby and bound context without deleted shapes or image bytes', () => {
    const scene = comment(empty());
    scene.elements.push({ ...shape, id: 'other', x: 800 }, { ...shape, id: 'label', type: 'text', text: 'label', containerId: 'shape' }, { ...shape, id: 'arrow', type: 'arrow', startBinding: { elementId: 'shape' }, endBinding: { elementId: 'other' } });
    const context = commentDrawingContext(scene, boardComments(scene)[0]);
    expect(context.attached.map(e => e.id)).toEqual(['shape']);
    expect(context.connected.map(e => e.id)).toContain('other');
    expect(context.connected.map(e => e.id)).toContain('label');
  });
});
