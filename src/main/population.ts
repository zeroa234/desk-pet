// Whole-desktop population policy. Keep current residents first, then fill slots in pack order.
export function populationLimit(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 64 ? value as number : null;
}
export function populationAbsent(ids: readonly string[], unlocked: readonly string[], requested: ReadonlySet<string>, residents: readonly string[], limit: number | null): Set<string> {
  const eligible = ids.filter(id => unlocked.includes(id) && !requested.has(id));
  const ordered = [...residents.filter(id => eligible.includes(id)), ...eligible.filter(id => !residents.includes(id))];
  const chosen = new Set(limit === null ? ordered : ordered.slice(0, limit));
  return new Set([...requested, ...eligible.filter(id => !chosen.has(id))]);
}
