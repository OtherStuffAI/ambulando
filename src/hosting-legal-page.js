import content from './hosting-legal-content.json';
import './ambulando-tokens.css';
import './hosting-legal.css';

const page = content[document.body.dataset.legalPage];
if (!page) throw new Error('Unknown legal page');
document.title = `${page.title} (draft) — Other Stuff`;
const main = document.querySelector('main');
const title = document.createElement('h1');
title.textContent = page.title;
main.append(title);
const notice = document.createElement('p');
notice.className = 'legal-draft';
notice.textContent = content.draftNotice;
main.append(notice);
for (const section of page.sections) {
  const node = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = section.title;
  node.append(heading);
  for (const text of section.paragraphs) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    if (text.startsWith('Editable draft fields:')) paragraph.className = 'legal-editable-field';
    node.append(paragraph);
  }
  main.append(node);
}
