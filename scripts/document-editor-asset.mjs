import path from 'node:path';

// Resolve the bundled entry, not a raw source asset (?url). Recovery can then
// change its module identity without importing code from a different release.
export function documentEditorAssetPlugin() {
  const publicId = 'virtual:document-editor-asset';
  const resolvedId = `\0${publicId}`;
  let building = false;
  let root;
  return {
    name: 'document-editor-asset',
    configResolved(config) {
      building = config.command === 'build';
      root = config.root;
    },
    resolveId(id) { if (id === publicId) return resolvedId; },
    load(id) {
      if (id !== resolvedId) return;
      if (!building) return 'export default "/src/docs/editor/tiptap-editor-adapter.js";';
      const reference = this.emitFile({ type: 'chunk',
        id: path.resolve(root, 'src/docs/editor/tiptap-editor-adapter.js'),
        // Allow shared exports (e.g. task editing) without a facade whose child
        // import would keep the failed browser module identity during recovery.
        name: 'tiptap-editor-adapter', preserveSignature: 'allow-extension' });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}
