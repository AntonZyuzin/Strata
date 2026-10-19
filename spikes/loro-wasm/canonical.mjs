// Canonical JSON with sorted keys — must match `canonical_json` in
// spikes/loro-index/src/main.rs byte for byte.
import { createHash } from 'node:crypto';

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'bigint') return v.toString();
  return JSON.stringify(v);
}

export function stateHash(doc) {
  return createHash('sha256').update(canonical(doc.toJSON())).digest('hex');
}
