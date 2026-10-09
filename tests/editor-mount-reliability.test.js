// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { showEditorMountFailure } from '../src/docs/editor/editor-mount-failure.js';
import { createDiagnosticOperation, finishDiagnosticOperation, observeDiagnostics } from '../src/diagnostics-events.js';

// Exercise the production methods with independent controlled module/factory
// failures, without booting unrelated app services or changing a saved draft.
describe('concurrent lazy editor failures', () => {
  for (const kind of ['document', 'task', 'daily-note']) for (const failure of ['import', 'factory']) {
    it(`${kind} shares handled ${failure} failure, retains draft and allows retry`, async () => {
      let rejectImport;
      let failFactory = failure === 'factory';
      const adapter = { editor: { view: { dom: document.createElement('div') } }, destroy: vi.fn(), getContentModel: () => ({content:'draft'}), getEditor() { return this.editor; } };
      const factory = vi.fn(() => { if (failFactory) throw new TypeError('controlled factory'); return adapter; });
      const pending = new Promise((resolve, reject) => { rejectImport = reject; if (failure === 'factory') resolve({createTiptapEditorAdapter:factory,createTaskDescriptionEditor:factory}); });
      const load = vi.fn(() => pending);
      const events = [];
      const stop = observeDiagnostics(event => events.push(event));
      const element = document.createElement('div');
      const names = {document:'mountDocRichEditor',task:'mountTaskRichDescriptionEditor','daily-note':'mountDailyNoteRichEditor'};
      const name = names[kind];
      const prefix = {document:'docRichEditor',task:'taskRichDescription','daily-note':'dailyNoteRichEditor'}[kind];
      let sourcePath = kind === 'document' ? '../src/docs-manager.js' : '../src/app.js';
      let source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      if (kind === 'task') source = source.replace("import('./task-description-editor.js')", 'loadTiptapEditorAdapter()');
      const start = source.indexOf(`    async ${name}(`) >= 0 ? source.indexOf(`    async ${name}(`) : source.indexOf(`  async ${name}(`);
      const indent = kind === 'document' ? '  ' : '    ';
      const end = source.indexOf(`\n${indent}},`, start) + indent.length + 3;
      const bindings = {loadTiptapEditorAdapter:load,createDiagnosticOperation,finishDiagnosticOperation,showEditorMountFailure,createDailyNoteTiptapToolbar:()=>({element:document.createElement('div')}),document};
      const mount = new Function(...Object.keys(bindings), `return ({${source.slice(start,end)}}).${name};`)(...Object.values(bindings));
      const store = {
        [name]:mount, selectedDocId:'doc', selectedDocument:{record_id:'doc'}, docEditorMode:'rich', docEditorContent:'retained draft', docEditorBlocks:[], docEditDraftDirty:true, docLocalDraft:{content:'retained draft'},
        editingTask:{record_id:'task',description:'retained draft'}, isTaskDetailEditing:()=>true, taskDescriptionEditing:true,
        dailyNoteEditorMode:'edit', dailyNoteEditorBody:'retained draft',
        getSelectedDocWorkspaceId:()=> 'workspace',
        isSelectedDocRichEditorEditable:()=>true, syncDocRichEditorContentModel:vi.fn(),
        [prefix+'MountGeneration']:0,
        ['destroy'+(kind==='document'?'DocRichEditor':kind==='task'?'TaskRichDescriptionEditor':'DailyNoteRichEditor')]() { this[prefix+'MountGeneration']++; this[prefix+'MountEl']=null; this[prefix+'MountPromise']=null; },
      };
      const first = store[name](element);
      const second = store[name](element);
      if (failure === 'import') rejectImport(new TypeError('controlled import'));
      expect(await Promise.all([first,second])).toEqual([false,false]);
      expect(load).toHaveBeenCalledOnce();
      expect(store[prefix+'LoadState']).toBe('error');
      expect(store.docEditorContent).toBe('retained draft');
      expect(store.editingTask.description).toBe('retained draft');
      expect(store.dailyNoteEditorBody).toBe('retained draft');
      expect(events.filter(e=>e.outcome==='failed')).toHaveLength(1);
      expect(events.find(e=>e.outcome==='failed').stage).toBe(failure);
      failFactory = false;
      load.mockResolvedValue({createTiptapEditorAdapter:factory,createTaskDescriptionEditor:factory});
      if (kind === 'document') {
        const retry = readFileSync('src/docs-manager.js','utf8');
        const a=retry.indexOf('  retrySelectedDocLoading() {'), b=retry.indexOf('\n  },',a)+5;
        store.retry = new Function(`return ({${retry.slice(a,b)}}).retrySelectedDocLoading;`)();
        expect(store.retry()).toBe(true);
        await store.docRichEditorMountPromise;
      } else {
        expect(element.querySelector('[role=alert]')).toBeTruthy();
        element.querySelector('button').click();
        await store[prefix+'MountPromise'];
      }
      expect(store[prefix+'LoadState']).toBe('ready');
      expect(store[prefix+'Adapter']).toBe(adapter);
      stop();
    });
  }
});
