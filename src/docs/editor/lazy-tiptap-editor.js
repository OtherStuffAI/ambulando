let adapterModulePromise;

export async function loadTiptapEditorAdapter() {
  adapterModulePromise ||= import('./tiptap-editor-adapter.js').catch((error) => {
    adapterModulePromise = null;
    throw error;
  });
  return adapterModulePromise;
}
