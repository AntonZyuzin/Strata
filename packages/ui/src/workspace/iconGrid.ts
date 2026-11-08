/** Cells in a row of the icon palette's grid (07 §6.3): the arrows move by one or by a row. */
export const COLS = 8;

/**
 * The cell `rows` rows away from cell `at`, in its column (07 §6.3): the
 * grid holds groups of so many cells, each from a row of its own, `COLS` to
 * a row. A shorter row gives its last cell; the move stops at the first and
 * the last row.
 */
export function rowMove(groups: readonly number[], at: number, rows: number): number {
  const starts: number[] = [];
  const lengths: number[] = [];
  let from = 0;
  for (const n of groups) {
    for (let k = 0; k < n; k += COLS) {
      starts.push(from + k);
      lengths.push(Math.min(COLS, n - k));
    }
    from += n;
  }
  if (starts.length === 0) return 0;
  let r = starts.length - 1;
  while (r > 0 && (starts[r] ?? 0) > at) r--;
  const col = at - (starts[r] ?? 0);
  const to = Math.max(0, Math.min(starts.length - 1, r + rows));
  return (starts[to] ?? 0) + Math.min(col, (lengths[to] ?? 1) - 1);
}
