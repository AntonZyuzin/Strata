/**
 * A list's rows follow the pointer only when it moves. A list that opens
 * under a resting pointer — the palette, «Перейти к ноде», the Tab menu —
 * gets pointer events for it (the browser updates the hover), and the row
 * there must not become the current one: `Enter` runs the first row
 * (09 §3.5). The first event only notes where the pointer is.
 */
export function pointerMoved(): (e: { clientX: number; clientY: number }) => boolean {
  let last: { x: number; y: number } | null = null;
  return (e) => {
    const was = last;
    last = { x: e.clientX, y: e.clientY };
    return was !== null && (was.x !== e.clientX || was.y !== e.clientY);
  };
}
