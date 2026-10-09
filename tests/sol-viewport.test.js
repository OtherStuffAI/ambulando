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

describe('phone footer focus visibility', () => {
  it('scrolls only the footer, skips unfocused/desktop/zoomed editors and removes observers', () => {
    const frames = new Map(); let next = 0;
    vi.stubGlobal('requestAnimationFrame', fn => { frames.set(++next, fn); return next; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    const flush = () => { for (const fn of frames.values()) fn(); frames.clear(); };
    const viewport = Object.assign(new EventTarget(), { scale:1 });
    const win = { innerWidth:390, visualViewport:viewport };
    const editor = { contains:target => target === editor, getBoundingClientRect:()=>({top:260,bottom:330}) };
    const doc = { activeElement:editor, addEventListener:vi.fn() };
    vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
    const disconnect = vi.fn(); let resize;
    vi.stubGlobal('ResizeObserver', class { constructor(fn) { resize=fn; } observe() {} disconnect=disconnect; });
    const directives={}; installSolAccessibility({directive:(name,handler)=>{directives[name]=handler;}});
    const footer=new EventTarget(); Object.assign(footer,{scrollTop:0,querySelector:selector=>selector === '.thread-input-actions' ? {getBoundingClientRect:()=>({top:290,bottom:334})} : editor,getBoundingClientRect:()=>({top:216,bottom:312})});
    let cleanup; directives['sol-composer-scroll'](footer,{}, {cleanup:fn=>{cleanup=fn;}});
    resize(); footer.dispatchEvent(new Event('input')); expect(frames.size).toBe(1); flush();
    expect(footer.scrollTop).toBe(22);
    doc.activeElement={}; resize(); flush(); expect(footer.scrollTop).toBe(22);
    doc.activeElement=editor; viewport.scale=2; resize(); flush(); expect(footer.scrollTop).toBe(22);
    viewport.scale=1; viewport.dispatchEvent(new Event('resize')); flush(); expect(footer.scrollTop).toBe(44); win.innerWidth=1440; resize(); flush(); expect(footer.scrollTop).toBe(44);
    cleanup(); expect(disconnect).toHaveBeenCalledOnce(); footer.dispatchEvent(new Event('input')); expect(frames.size).toBe(0);
  });
});
