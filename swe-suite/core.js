// Pure logic shared by swe.html. No DOM, no I/O, no clock.
// Mirror of backend-plugin/db.py (spec_readiness); vectors/readiness.json, generated
// from the Python side, keeps the two in step. After editing, run `node swe-suite/build.mjs`
// to re-embed this file into swe.html.
const SweCore = (() => {
  const READY_KINDS = ['feature', 'story'];
  const MAX_READY_ESTIMATE = 5;
  const ESTIMATES = [1, 2, 3, 5, 8, 13];

  /** Definition of Ready: can this node be committed to an hour? `criteria_json` is a JSON string. */
  function readiness({ kind, criteria_json, estimate }) {
    if (!READY_KINDS.includes(kind)) return { applies: false, ready: true, checks: [] };
    let parsed;
    try { parsed = criteria_json ? JSON.parse(criteria_json) : []; } catch { parsed = null; }
    const valid = Array.isArray(parsed) && parsed.length > 0 && parsed.every((c) => typeof c === 'string' && c.trim() !== '');
    const hasEstimate = estimate !== null && estimate !== undefined;
    const checks = [
      { name: 'criteria', passed: valid, detail: valid ? `${parsed.length} acceptance criteria` : 'needs at least one acceptance criterion' },
      { name: 'estimate', passed: hasEstimate, detail: hasEstimate ? `${estimate} points` : 'needs an estimate' },
    ];
    if (hasEstimate) {
      const fits = estimate <= MAX_READY_ESTIMATE;
      checks.push({
        name: 'size', passed: fits,
        detail: fits ? `fits one hour (at most ${MAX_READY_ESTIMATE} points)` : `${estimate} points is too big for one hour; split it to ${MAX_READY_ESTIMATE} or fewer`,
      });
    }
    return { applies: true, ready: checks.every((c) => c.passed), checks };
  }

  const KINDS = ['theme', 'epic', 'feature', 'story'];
  const STATUSES = ['draft', 'ready', 'converted'];  // what an edit may set; files may hold others (e.g. "approved")
  const DEFAULT_LIMITS = { text: 20000, criteria: 100 };
  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;  // an id becomes a filename, so no separators

  /** Why a spec node file is invalid, or null. Does not check the filename, duplicates or parent. */
  function validateNode(n, limits = DEFAULT_LIMITS) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return 'not an object';
    if (typeof n.id !== 'string' || !n.id) return 'missing id';
    if (!ID_PATTERN.test(n.id) || n.id.length > 200) return 'invalid id';
    if (!KINDS.includes(n.kind)) return `invalid kind ${JSON.stringify(n.kind)}`;
    if (typeof n.title !== 'string' || !n.title.trim() || n.title.length > limits.text) return 'invalid title';
    if (n.parent_id != null && typeof n.parent_id !== 'string') return 'invalid parent_id';
    if (n.criteria != null && (!Array.isArray(n.criteria) || n.criteria.length > limits.criteria || !n.criteria.every((c) => typeof c === 'string' && c.length <= limits.text))) return 'criteria must be an array of strings';
    if (n.estimate != null && !ESTIMATES.includes(n.estimate)) return `estimate must be one of ${ESTIMATES.join(', ')}`;
    if (n.task_ref != null && (typeof n.task_ref !== 'string' || n.task_ref.length > 200)) return 'task_ref must be a short string';
    return null;
  }

  /** JSON text exactly as Python's json.dumps(value, indent=2, sort_keys=True) + "\n": sorted keys,
   *  non-ASCII escaped. (Keys sort by UTF-16 unit, Python by code point; they differ only for
   *  astral-plane keys, which node files do not use.) Integers only: 1.0 would come back as 1. */
  function canonicalJson(value) {
    const str = (s) => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const walk = (v, pad) => {
      if (Array.isArray(v)) {
        if (!v.length) return '[]';
        const inner = pad + '  ';
        return '[\n' + v.map((x) => inner + walk(x, inner)).join(',\n') + '\n' + pad + ']';
      }
      if (v && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        if (!keys.length) return '{}';
        const inner = pad + '  ';
        return '{\n' + keys.map((k) => inner + str(k) + ': ' + walk(v[k], inner)).join(',\n') + '\n' + pad + '}';
      }
      return typeof v === 'string' ? str(v) : JSON.stringify(v);
    };
    return walk(value, '') + '\n';
  }

  /** A filename-safe id from a title, unique among `taken` (a Set). */
  function newNodeId(title, taken) {
    const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'node';
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  /** Apply an edit {title, status, estimate, task_ref, criteria} (any subset; null clears estimate/task_ref)
   *  to a node file's object. Returns a new object; throws Error with the reason when it is not allowed. */
  function applyEdit(src, edit, limits = DEFAULT_LIMITS) {
    const next = { ...src };
    if ('title' in edit) next.title = String(edit.title).trim();
    if ('criteria' in edit) next.criteria = edit.criteria.map((c) => String(c).trim()).filter(Boolean);
    for (const key of ['estimate', 'task_ref']) {
      if (!(key in edit)) continue;
      if (edit[key] === null || edit[key] === '') delete next[key]; else next[key] = edit[key];
    }
    if ('status' in edit) {
      if (edit.status !== src.status && !STATUSES.includes(edit.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      next.status = edit.status;
    }
    const bad = validateNode(next, limits);
    if (bad) throw new Error(bad);
    if (next.status === 'ready' && src.status !== 'ready') {
      const r = readiness({ kind: next.kind, criteria_json: JSON.stringify(next.criteria || []), estimate: next.estimate ?? null });
      if (!r.ready) throw new Error('not ready: ' + r.checks.filter((c) => !c.passed).map((c) => c.detail).join('; '));
    }
    return next;
  }

  return { readiness, validateNode, canonicalJson, newNodeId, applyEdit, KINDS, STATUSES, ESTIMATES, MAX_READY_ESTIMATE };
})();
