/**
 * A drag let go where nothing takes it: the browser, and the desktop's
 * WebView with its own drag and drop off (`dragDropEnabled: false`, so that
 * the canvas, the palette `Z` and the board take files as HTML5 drops), would
 * open a file or a link — a picture dragged from a browser is one — in place
 * of the app, with no way back. The window refuses every drag nothing on the
 * page accepted; its listeners hear the drag after the page's have. Text and
 * links dragged into a field are left to the browser, which types them in.
 * The desktop shell refuses to leave the app's page besides (`own_page`).
 */
export function guardDrops(win: Window): void {
  const refuse = (e: DragEvent) => {
    const data = e.dataTransfer;
    if (e.defaultPrevented || !data) return;
    if (!data.types.includes('Files') && typesInto(e.target)) return;
    e.preventDefault();
    if (e.type === 'dragover') data.dropEffect = 'none';
  };
  win.addEventListener('dragover', refuse);
  win.addEventListener('drop', refuse);
}

/** A field that takes dropped text: an input, a text area, an editor. */
function typesInto(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('input, textarea') !== null;
}
