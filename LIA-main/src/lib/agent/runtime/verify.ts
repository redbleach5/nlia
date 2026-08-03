/** Pure helpers for Create Runtime verify (no I/O). */

export function stepsHaveRuntimeVerify(
  steps: Array<{ action: string; observation?: string }>,
): boolean {
  return steps.some(s => {
    const action = (s.action || '').toLowerCase();
    if (!/runtime_start/.test(action)) return false;
    const obs = (s.observation || '').toLowerCase();
    if (/"success"\s*:\s*false/.test(obs)) {
      if (!/"status"\s*:\s*"(healthy|running)"/.test(obs)) return false;
    }
    if (/"error"\s*:/.test(s.observation || '') && !/"success"\s*:\s*true/.test(obs)) {
      return false;
    }
    return /"success"\s*:\s*true/.test(obs) || /"status"\s*:\s*"(healthy|running)"/.test(obs);
  });
}
