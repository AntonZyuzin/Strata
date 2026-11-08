/**
 * A file let go where nothing takes it: the browser, and the desktop's
 * WebView with its own drag and drop off (`dragDropEnabled: false`, so that
 * the canvas, the palette `Z` and the board take files as HTML5 drops), would
 * open the file in place of the app. The window refuses a file drag nothing
 * on the page accepted; its listeners hear the drag after the page's have.
 * Text dragged into a field is left to the browser.
 */
export function guardDrops(win: Window): void {
  win.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  win.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
  });
}
