import adapterAssetUrl from 'virtual:document-editor-asset';

export function createEditorAdapterLoader({
  initialImport = () => import('./tiptap-editor-adapter.js'),
  recoveryImport = (url) => import(/* @vite-ignore */ url),
  assetUrl = adapterAssetUrl,
  timeoutMs = 8000,
} = {}) {
  let readyModule;
  let pending;
  let retrySequence = 0;
  return async ({ retry = false } = {}) => {
    if (readyModule) return readyModule;
    if (pending) return pending;
    const url = retry ? `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}editor-retry=${++retrySequence}` : null;
    let timer;
    const importing = Promise.resolve().then(() => retry ? recoveryImport(url) : initialImport());
    const attempt = Promise.race([importing, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Document editor import timed out')), timeoutMs);
    })]).then((module) => {
      readyModule = module;
      return module;
    }).finally(() => {
      clearTimeout(timer);
      if (pending === attempt) pending = null;
    });
    pending = attempt;
    return attempt;
  };
}

export const loadTiptapEditorAdapter = createEditorAdapterLoader();
