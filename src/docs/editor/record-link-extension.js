import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export function recordLinkRange(state) {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === 'codeBlock'
    || $from.marks().some(mark => ['code', 'link', 'fdMention'].includes(mark.type.name))) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
  const match = /(?:^|\s)@([^@\n]*)$/.exec(before);
  if (!match) return null;
  const token = `@${match[1]}`;
  return { from: $from.pos - token.length, to: $from.pos, query: match[1] };
}

export function insertRecordLink(editor, range, choice) {
  if (!choice?.id || !choice?.label || !editor.isEditable) return false;
  const mark = choice.url
    ? { type: 'link', attrs: { href: choice.url, target: '_blank', rel: 'noopener noreferrer' } }
    : { type: 'fdMention', attrs: { mentionType: choice.type, mentionId: choice.id, label: choice.label } };
  const marks = editor.state.selection.$from.marks()
    .filter(existing => !['link', 'fdMention'].includes(existing.type.name)).map(existing => existing.toJSON());
  return editor.chain().focus().insertContentAt(range, [
    { type: 'text', text: choice.label, marks: [...marks, mark] }, { type: 'text', text: ' ', marks },
  ]).run();
}

// This picker only edits prose. It never builds structured instruction mentions.
export function createRecordLinkPicker({ search }) {
  return Extension.create({
    name: 'fdRecordLinkPicker',
    addProseMirrorPlugins() {
      let picker;
      const editor = this.editor;
      return [new Plugin({
        props: {
          handleKeyDown: (_view, event) => picker?.keydown(event) || false,
          handleDOMEvents: { blur: () => { picker?.dismiss(); return false; } },
        },
        view(view) {
          const el = document.createElement('div');
          el.className = 'fd-wiki-picker fd-record-link-picker';
          el.setAttribute('role', 'listbox'); el.setAttribute('aria-label', 'Link to a record');
          document.body.append(el);
          let signature = '', dismissed = '', request = 0, range = null, choices = [], active = 0, destroyed = false;
          const choose = index => {
            if (!range || !choices[index] || !editor.isEditable) return;
            const current = recordLinkRange(view.state);
            if (!current || current.from !== range.from || current.to !== range.to || current.query !== range.query) return;
            dismissed = signature; el.hidden = true;
            insertRecordLink(editor, { from: range.from, to: range.to }, choices[index]);
          };
          const paint = message => {
            el.replaceChildren();
            choices.forEach((choice, index) => {
              const button = document.createElement('button');
              button.type = 'button'; button.setAttribute('role', 'option');
              button.setAttribute('aria-selected', String(index === active));
              button.textContent = `${choice.label} · ${choice.sublabel || choice.type}`;
              button.addEventListener('pointerdown', event => event.preventDefault());
              button.addEventListener('click', () => choose(index));
              el.append(button);
            });
            if (!choices.length || message) {
              const status = document.createElement('div'); status.setAttribute('role', 'status');
              status.textContent = message || 'No accessible records found'; el.append(status);
            }
            el.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
          };
          const render = () => {
            range = editor.isEditable && !view.composing ? recordLinkRange(view.state) : null;
            const next = range ? `${range.from}:${range.to}:${range.query}` : '';
            el.hidden = !range || next === dismissed;
            if (next === signature) return;
            signature = next; const ticket = ++request; active = 0; choices = [];
            if (el.hidden) return;
            paint('Searching accessible records…');
            const rect = view.coordsAtPos(view.state.selection.from);
            el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 16)))}px`;
            el.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 240))}px`;
            const query = range.query;
            const publish = result => {
              if (destroyed || ticket !== request || el.hidden) return;
              choices = Array.isArray(result) ? result : result.choices || [];
              active = Math.min(active, Math.max(0, choices.length - 1));
              paint(result.message);
            };
            Promise.resolve().then(() => search(query, publish)).then(publish, () => { if (!destroyed && ticket === request) paint('Could not load records. Your text is unchanged.'); });
          };
          picker = { dismiss() { dismissed = signature; el.hidden = true; }, keydown(event) {
            if (el.hidden || event.isComposing) return false;
            if (event.key === 'Escape') { dismissed = signature; el.hidden = true; return true; }
            if (['ArrowDown', 'ArrowUp'].includes(event.key) && choices.length) {
              active = (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; paint(); return true;
            }
            if (event.key === 'Enter' && choices.length) { choose(active); return true; }
            return false;
          } };
          render();
          return { update: render, destroy() { destroyed = true; ++request; el.remove(); picker = null; } };
        },
      })];
    },
  });
}
