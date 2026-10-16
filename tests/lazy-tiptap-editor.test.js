import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorAdapterLoader } from '../src/docs/editor/lazy-tiptap-editor.js';

afterEach(() => vi.useRealTimers());

describe('editor module delivery', () => {
  it('coalesces imports and reuses a successfully recovered module', async () => {
    const module = { createTiptapEditorAdapter: () => {} };
    const initialImport = vi.fn().mockRejectedValue(new TypeError('Importing a module script failed'));
    const recoveryImport = vi.fn().mockResolvedValue(module);
    const load = createEditorAdapterLoader({ initialImport, recoveryImport, assetUrl: '/assets/editor-hash.js' });
    await expect(load()).rejects.toThrow('module script');
    expect(await Promise.all([load({ retry: true }), load({ retry: true })])).toEqual([module, module]);
    expect(recoveryImport).toHaveBeenCalledExactlyOnceWith('/assets/editor-hash.js?editor-retry=1');
    expect(await load()).toBe(module);
    expect(initialImport).toHaveBeenCalledTimes(1);
  });

  it('uses a new module identity for every explicit recovery, without retrying by itself', async () => {
    const recoveryImport = vi.fn().mockRejectedValue(new Error('404'));
    const load = createEditorAdapterLoader({ recoveryImport, assetUrl: '/assets/editor-old.js' });
    await expect(load({ retry: true })).rejects.toThrow('404');
    await expect(load({ retry: true })).rejects.toThrow('404');
    expect(recoveryImport.mock.calls.map(([url]) => url)).toEqual([
      '/assets/editor-old.js?editor-retry=1', '/assets/editor-old.js?editor-retry=2',
    ]);
  });

  it('bounds a stalled import and ignores its late success so it cannot replace a recovery', async () => {
    vi.useFakeTimers();
    let finish;
    const recovered = { recovered: true };
    const load = createEditorAdapterLoader({ initialImport: () => new Promise(resolve => { finish = resolve; }),
      recoveryImport: async () => recovered, assetUrl: '/assets/editor.js', timeoutMs: 100 });
    const pending = expect(load()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(await load({ retry: true })).toBe(recovered);
    finish({ stale: true });
    await Promise.resolve();
    expect(await load()).toBe(recovered);
  });
});
