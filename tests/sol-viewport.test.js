import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSolAccessibility } from '../src/sol-accessibility.js';

afterEach(() => vi.unstubAllGlobals());

describe('phone visual viewport', () => {
  it('tracks keyboard height and pan, preserves pinch zoom, and cleans up listeners', () => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height:844, offsetTop:0, scale:1 });
    const frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('window', { visualViewport:viewport });
    vi.stubGlobal('document', { addEventListener:vi.fn() });
    vi.stubGlobal('requestAnimationFrame', fn => { frames.set(++nextFrame,fn); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    const flush = () => { for(const fn of frames.values()) fn(); frames.clear(); };
    const directives = {};
    installSolAccessibility({ directive:(name, handler) => { directives[name]=handler; } });
    const values = new Map();
    const element = { style:{ setProperty:(key,value) => values.set(key,value), removeProperty:key => values.delete(key) } };
    let cleanup;
    directives['sol-viewport'](element, {}, { cleanup:fn => { cleanup=fn; } });
    flush();
    expect(values.get('--sol-visual-height')).toBe('844px');
    Object.assign(viewport, { height:420, offsetTop:24 });
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    flush();
    expect(values.get('--sol-visual-height')).toBe('420px');
    expect(values.get('--sol-visual-top')).toBe('24px');
    Object.assign(viewport, { height:210, scale:2 });
    viewport.dispatchEvent(new Event('resize'));
    flush();
    expect(values.get('--sol-visual-height')).toBe('420px');
    Object.assign(viewport, { height:844, offsetTop:0, scale:1 });
    viewport.dispatchEvent(new Event('resize'));
    flush();
    expect(values.get('--sol-visual-height')).toBe('844px');
    cleanup();
    expect(values.size).toBe(0);
    viewport.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(0);
  });
});
