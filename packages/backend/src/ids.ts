const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastMs = 0;
let counter = 0;

/**
 * A 26-character time-ordered id in the Crockford base32 form of 05 §4.1:
 * 48 bits of milliseconds, then 80 random bits, like the text form of
 * UUIDv7 that strata-model produces. The prototype makes ids in the UI;
 * from milestone 1A the core does.
 */
export function newId(now = Date.now()): string {
  if (now === lastMs) counter++;
  else {
    lastMs = now;
    counter = 0;
  }
  const chars = new Array<string>(26);
  let ms = now;
  for (let k = 9; k >= 0; k--) {
    chars[k] = ALPHABET[ms % 32] ?? '0';
    ms = Math.floor(ms / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  // Keep ids made in the same millisecond ordered: the counter leads the random part.
  chars[10] = ALPHABET[(counter >> 5) & 31] ?? '0';
  chars[11] = ALPHABET[counter & 31] ?? '0';
  for (let k = 12; k < 26; k++) chars[k] = ALPHABET[(random[k - 12] ?? 0) & 31] ?? '0';
  return chars.join('');
}
