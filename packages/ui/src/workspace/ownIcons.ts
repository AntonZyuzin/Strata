import { MASK_SIDE, type Pixels, type StyleMode, type StyleParams, stylize } from '@strata/canvas';

/** The prefix of one's own icon in a node's `icon` (05 §4.1 `IconRef`, 07 §6.6). */
export const OWN_ICON = 'asset/';

/** Pictures are decoded at most this large: the mask is 128 px (07 §6.7), R7 measured 512. */
const DECODE_SIDE = 512;

/** The modes whose threshold one sets by hand (07 §6.5); the others have none. */
export function takesThreshold(mode: StyleMode): boolean {
  return mode === 'engraving' || mode === 'pixel';
}

/**
 * The reference of one's own icon, one spelling per style (07 §6.6):
 * `asset/<sha256>/<mode>[/t<threshold>][/i]` — no threshold is Otsu's.
 */
export function ownIconRef(sha: string, style: StyleParams): string {
  let ref = `${OWN_ICON}${sha}/${style.mode}`;
  if (style.threshold !== null && takesThreshold(style.mode)) {
    ref += `/t${Math.max(0, Math.min(255, Math.round(style.threshold)))}`;
  }
  if (style.invert) ref += '/i';
  return ref;
}

const REF =
  /^asset\/([0-9a-fA-F]{64})\/(engraving|pixel|silhouette|photo|as-is)(?:\/t(0|[1-9]\d{0,2}))?(\/i)?$/;

/** The original and the style of one's own icon; null — the value is not one. */
export function parseOwnIcon(ref: string | null | undefined): {
  sha: string;
  style: StyleParams;
} | null {
  const m = ref ? REF.exec(ref) : null;
  if (!m?.[1] || !m[2]) return null;
  const threshold = m[3] === undefined ? null : Number(m[3]);
  if (threshold !== null && threshold > 255) return null;
  return {
    sha: m[1],
    style: { mode: m[2] as StyleMode, threshold, invert: m[4] !== undefined },
  };
}

/**
 * A picture's pixels, its long side at most 512 px (07 §6.4). Through an
 * `<img>`, so an SVG runs no script and loads nothing outside; it is never
 * put into the page, only drawn.
 */
export async function decodePicture(blob: Blob): Promise<Pixels> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || DECODE_SIDE;
    const h0 = img.naturalHeight || DECODE_SIDE;
    const k = Math.min(1, DECODE_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    ctx.drawImage(img, 0, 0, w, h);
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A stored original as a picture the `<img>` takes: an SVG needs its type —
 * the browser sniffs only the raster formats. An SVG starts with `<` after
 * spaces and a byte order mark; the raster formats with their magic bytes.
 */
export function blobOf(bytes: Uint8Array): Blob {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i] ?? 0)) i++;
  const svg = bytes[i] === 0x3c;
  return new Blob([bytes as BlobPart], svg ? { type: 'image/svg+xml' } : {});
}

/** The masks made this session, by reference: derivatives, rebuilt, not stored (05 §12, 07 §6.6). */
const made = new Map<string, Promise<Uint8ClampedArray>>();

/**
 * The mask of one's own icon (07 §6.5): the original from the store through
 * «привести к стилю» in the reference's style, `MASK_SIDE` square, the alpha
 * the ink. Made once per reference.
 */
export function ownIconMask(
  ref: string,
  asset: (sha: string) => Promise<Uint8Array>,
): Promise<Uint8ClampedArray> {
  const known = made.get(ref);
  if (known) return known;
  const own = parseOwnIcon(ref);
  const done = own
    ? asset(own.sha)
        .then((bytes) => decodePicture(blobOf(bytes)))
        .then((px) => stylize(px, own.style).mask)
    : Promise.reject(new Error(`not one's own icon: ${ref}`));
  // A picture that would not decode is tried again next time, not kept failed.
  done.catch(() => made.delete(ref));
  made.set(ref, done);
  return done;
}

/** The masks as pictures, by reference: the palette draws them in ink (07 §6.5). */
const urls = new Map<string, Promise<string>>();

/**
 * The mask of one's own icon as a picture whose alpha is the ink: a CSS
 * mask over the text's colour draws it as the presets are drawn. Made once
 * per reference.
 */
export function ownIconUrl(
  ref: string,
  asset: (sha: string) => Promise<Uint8Array>,
): Promise<string> {
  const known = urls.get(ref);
  if (known) return known;
  const done = ownIconMask(ref, asset).then((mask) => {
    const side = Math.round(Math.sqrt(mask.length));
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    const img = ctx.createImageData(side, side);
    for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] = mask[i] ?? 0;
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  });
  done.catch(() => urls.delete(ref));
  urls.set(ref, done);
  return done;
}

/**
 * A drag that carries a file which may be a picture (07 §6.4). While one
 * drags, only the files' types are to be read, and a system may give none.
 */
export function carriesPicture(dt: Pick<DataTransfer, 'items'> | null): boolean {
  if (!dt) return false;
  for (const item of Array.from(dt.items)) {
    if (item.kind === 'file' && (item.type === '' || item.type.startsWith('image/'))) return true;
  }
  return false;
}

/** The first picture of a drop; a file of no type is tried — decoding tells. */
export function droppedPicture(dt: Pick<DataTransfer, 'files'> | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files)) {
    if (f.type === '' || f.type.startsWith('image/')) return f;
  }
  return null;
}

export { MASK_SIDE };
