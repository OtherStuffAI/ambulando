export function withNostrActorName(row, value) {
  if (typeof value !== 'string') return row;
  const name = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip controls from untrusted public profile names.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!name) return row;
  return {
    ...row,
    actorName: name,
    title: `${row.type} from ${name}${row.amount ? ` · ${row.amount / 1000} sats` : ''}`,
  };
}
