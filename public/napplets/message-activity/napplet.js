(() => {
  'use strict';
  const session = location.hash.slice(1);
  const status = document.getElementById('status');
  const range = document.getElementById('range');
  const refresh = document.getElementById('refresh');
  const summary = document.getElementById('summary');
  const scopes = document.getElementById('scopes');
  const send = (type, extra = {}) => parent.postMessage({ version: 1, session, type, ...extra }, '*');
  const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
  const count = value => value.toLocaleString();
  const utc = value => value.replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, '');
  range.addEventListener('change', () => send('range', { range: range.value }));
  refresh.addEventListener('click', () => send('refresh'));
  // Escape inside a frame does not reliably bubble to its parent dialog.
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); send('close'); } });
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.version !== 1 || data.session !== session || data.type !== 'state'
      || !['7d', '30d', 'all'].includes(data.range)) return;
    range.value = data.range;
    summary.replaceChildren(); scopes.replaceChildren(); summary.hidden = true;
    refresh.disabled = data.status === 'loading';
    status.setAttribute('role', data.status === 'error' ? 'alert' : 'status');
    if (data.status === 'loading') { status.textContent = 'Loading complete counts…'; return; }
    if (data.status === 'error') { status.textContent = data.error; return; }
    const p = data.projection;
    if (data.status !== 'ready' || p?.complete !== true) return;
    status.textContent = p.channel_count === 0 ? 'No accessible channels in this workspace.'
      : p.total === 0 ? 'No messages in this time range.' : 'Complete authorized channel snapshot.';
    summary.hidden = false;
    summary.append(node('h2', `${count(p.total)} ${p.total === 1 ? 'message' : 'messages'}`), node('p', `${count(p.channel_count)} ${p.channel_count === 1 ? 'channel' : 'channels'} · ${count(p.scopes.length)} ${p.scopes.length === 1 ? 'scope' : 'scopes'}`),
      node('p', `${p.from ? utc(p.from) : 'All time'} → ${utc(p.as_of)} UTC`));
    for (const scope of p.scopes) {
      const section = document.createElement('section');
      section.className = 'scope'; section.append(node('h2', `${scope.label} · ${count(scope.count)}`));
      const table = document.createElement('table');
      const caption = node('caption', `Channels in ${scope.label}`); table.append(caption);
      const head = document.createElement('thead'), heading = document.createElement('tr');
      for (const label of ['Channel', 'Messages']) { const cell = node('th', label); cell.scope = 'col'; heading.append(cell); }
      head.append(heading); table.append(head);
      const body = document.createElement('tbody');
      for (const channel of scope.channels) { const row = document.createElement('tr'); row.append(node('td', channel.label), node('td', count(channel.count))); body.append(row); }
      table.append(body); section.append(table); scopes.append(section);
    }
  });
  send('ready');
})();
