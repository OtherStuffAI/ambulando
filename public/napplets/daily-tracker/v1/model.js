/* Shared by the self-contained bundle and host validation. No storage or transport. */
(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y,m,d] = value.split('-').map(Number);
    if (y < 1 || m < 1 || m > 12 || d < 1) return false;
    return d <= [31, y%4===0 && (y%100!==0 || y%400===0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31][m-1];
  }
  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function localDate(now = new Date()) {
    return `${String(now.getFullYear()).padStart(4,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }
  function validate(input) {
    const fail = () => { throw new Error('Invalid daily tracker document.'); };
    if (!keys(input,['format','metrics','days']) || input.format !== 'daily-tracker-v1' || !Array.isArray(input.metrics) || input.metrics.length > 200 || !object(input.days) || Object.keys(input.days).length > 36600) fail();
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1048576) fail();
    const metrics = new Map();
    for (const m of input.metrics) {
      if (!keys(m,['id','label','type','unit','archived']) || !UUID.test(m.id) || metrics.has(m.id) || typeof m.label !== 'string' || !m.label.trim() || m.label.length > 120 || /[\u0000-\u001f\u007f]/.test(m.label) || !['boolean','number'].includes(m.type) || typeof m.unit !== 'string' || m.unit.length > 24 || /[\u0000-\u001f\u007f]/.test(m.unit) || typeof m.archived !== 'boolean') fail();
      metrics.set(m.id,m);
    }
    for (const [date, values] of Object.entries(input.days)) {
      if (!validDate(date) || !object(values)) fail();
      for (const [id,v] of Object.entries(values)) {
        const m = metrics.get(id);
        if (!m || (m.type === 'boolean' ? typeof v !== 'boolean' : typeof v !== 'number' || !Number.isFinite(v))) fail();
      }
    }
    return structuredClone(input);
  }
  function validateReplacement(before, after) {
    const next = validate(after);
    for (const m of before.metrics) {
      const used = Object.values(before.days).some(d => Object.hasOwn(d,m.id));
      const replacement = next.metrics.find(n => n.id === m.id);
      if (used && (!replacement || replacement.type !== m.type)) throw new Error('Keep historical metrics and their original types; archive them instead.');
    }
    return next;
  }
  globalThis.DailyTrackerModel = Object.freeze({validate,validateReplacement,validDate,localDate,uuid,empty:()=>({format:'daily-tracker-v1',metrics:[],days:{}})});
})();
