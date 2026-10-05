// Keep the existing rendered text (including block separators). Wiki titles are
// live presentation, while the integrity guard must compare saved fallback labels.
export function visibleWikiIntegrityText(element) {
  const visible = String(element?.innerText || element?.textContent || '').trim();
  const links = element?.querySelectorAll?.('[data-wiki-title]') || [];
  if (!links.length || !element.ownerDocument?.createRange) return visible;
  const replacements = [];
  for (const link of links) {
    const label = String(link.innerText || link.textContent || '');
    const saved = String(link.dataset.wikiTitle || '');
    if (label === saved || !label) continue;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.setEndBefore(link);
    const prefixLength = range.toString().replace(/\s/g, '').length;
    let offset = 0, count = 0;
    while (offset < visible.length && count < prefixLength) {
      if (!/\s/.test(visible[offset])) count++;
      offset++;
    }
    while (offset < visible.length && !visible.startsWith(label, offset) && /\s/.test(visible[offset])) offset++;
    // Refuse a normalization that cannot be mapped safely; never remove prose
    // or substitute an earlier identical title in another paragraph.
    if (!visible.startsWith(label, offset)) continue;
    replacements.push({ from: offset, to: offset + label.length, text: saved });
  }
  return replacements.reverse().reduce((text, patch) => text.slice(0, patch.from) + patch.text + text.slice(patch.to), visible);
}
