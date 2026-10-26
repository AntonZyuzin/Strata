/**
 * A network's path as a row shows it: the names under the root, as
 * «Перейти к ноде» shows them (09 §3.4); the root by its own name.
 */
export function pathLabel(path: readonly (readonly [string, string])[]): string {
  if (path.length <= 1) return path[0]?.[1] ?? '';
  return path
    .slice(1)
    .map(([, name]) => name)
    .join(' / ');
}
