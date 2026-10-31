import { diffArrays, diffLines } from 'diff';

const equal = (a, b) => JSON.stringify(mergeValue(a)) === JSON.stringify(mergeValue(b));

// Ignore editor identities for comparison, retaining them in the merged tree
// so existing comment anchors can continue to address unchanged blocks.
function mergeValue(value) {
  if (Array.isArray(value)) return value.map(mergeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    if (key === 'fdBlockId' || key === 'pmNodeId') return [];
    const next = mergeValue(value[key]);
    return key === 'attrs' && next && !Object.keys(next).length ? [] : [[key, next]];
  }));
}

function edits(base, value) {
  const changes = diffArrays(base, value, { comparator: equal, timeout: 500, maxEditLength: 4000 });
  if (!changes) return null;
  let offset = 0;
  const result = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change.added && !change.removed) { offset += change.count; continue; }
    const start = offset;
    let end = offset;
    const replacement = [];
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      if (changes[i].removed) { end += changes[i].count; offset += changes[i].count; }
      else replacement.push(...changes[i].value);
      i++;
    }
    i--;
    result.push({ start, end, replacement });
  }
  return result;
}

export function threeWayMerge(base, local, latest, resolutions = {}) {
  const conflicts = [];
  const conflict = (b, l, r, path) => {
    const id = JSON.stringify(path);
    const choice = resolutions[id];
    conflicts.push({ id, path: path.join(' / '), base: b, local: l, latest: r, choice: choice || '' });
    return choice === 'latest' ? r : l;
  };
  const merge = (b, l, r, path) => {
    if (['fdBlockId', 'pmNodeId'].includes(path.at(-1))) return r ?? l ?? b;
    if (equal(l, r) || equal(b, r)) return l;
    if (equal(b, l)) return r;
    if (typeof b === 'string' && typeof l === 'string' && typeof r === 'string') {
      // A Unicode code point is atomic. Bounded diff falls back to explicit review.
      return sequence([...b], [...l], [...r], path, true).join('');
    }
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(r)) return sequence(b, l, r, path);
    if (b && l && r && [b, l, r].every(v => typeof v === 'object' && !Array.isArray(v))) {
      return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])]
        .sort().map(k => [k, merge(b[k], l[k], r[k], [...path, k])]).filter(([, v]) => v !== undefined));
    }
    return conflict(b, l, r, path);
  };
  const sequence = (b, l, r, path, text = false) => {
    const left = edits(b, l), right = edits(b, r);
    if (!left || !right) return conflict(b, l, r, path);
    const all = [...left.map(e => ({ ...e, side: 'local' })), ...right.map(e => ({ ...e, side: 'latest' }))]
      .sort((a, c) => a.start - c.start || a.end - c.end);
    const output = [];
    let offset = 0;
    while (all.length) {
      const group = [all.shift()];
      const start = group[0].start;
      let end = group[0].end;
      // Touching replacements are independent; insertion at an edited boundary
      // is deliberately conservative because its intended order is ambiguous.
      while (all.length && (all[0].start < end || (all[0].start === end
        && (all[0].start === all[0].end || group.some(e => e.start === e.end))))) {
        const next = all.shift(); group.push(next); end = Math.max(end, next.end);
      }
      output.push(...b.slice(offset, start));
      const apply = side => {
        const result = []; let pos = start;
        for (const e of group.filter(e => e.side === side)) {
          result.push(...b.slice(pos, e.start), ...e.replacement); pos = e.end;
        }
        return [...result, ...b.slice(pos, end)];
      };
      const hasLocal = group.some(e => e.side === 'local');
      const hasRemote = group.some(e => e.side === 'latest');
      const original = b.slice(start, end), ours = apply('local'), theirs = apply('latest');
      let result;
      if (!hasLocal) result = theirs;
      else if (!hasRemote || equal(ours, theirs)) result = ours;
      else if (!text && original.length === 1 && ours.length === 1 && theirs.length === 1) {
        result = [merge(original[0], ours[0], theirs[0], [...path, start])];
      } else result = conflict(original, ours, theirs, [...path, `${start}:${end}`]);
      output.push(...result); offset = end;
    }
    return [...output, ...b.slice(offset)];
  };
  const value = merge(base, local, latest, []);
  return { value, conflicts, unresolved: conflicts.filter(c => !['local', 'latest'].includes(c.choice)).length };
}

export function reviewDocumentChanges(input) {
  const result = input.base ? threeWayMerge(input.base, input.local, input.latest, input.resolutions) : null;
  const diff = diffLines(input.localText || '', input.latestText || '', { timeout: 500, maxEditLength: 4000 });
  return { ...result, diff: diff || [{ value: 'Document is too large for an inline diff. Compare the complete copies below.' }] };
}
