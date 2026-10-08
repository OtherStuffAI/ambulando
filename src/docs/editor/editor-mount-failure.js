// Only failed lazy mounting is handled here. Editor event callbacks retain their
// normal error behavior, and the draft model is never read or replaced.
export function showEditorMountFailure(element, retry) {
  const doc = element.ownerDocument;
  const status = doc.createElement('div');
  status.setAttribute('role', 'alert');
  const message = doc.createElement('p');
  message.textContent = 'Editor could not load. Your draft is retained. Try again.';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.textContent = 'Try again';
  button.addEventListener('click', () => { void retry(); });
  status.append(message, button);
  element.replaceChildren(status);
}
