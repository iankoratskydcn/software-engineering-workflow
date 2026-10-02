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

  return { readiness, ESTIMATES, MAX_READY_ESTIMATE };
})();
