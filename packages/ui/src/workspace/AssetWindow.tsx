import { type Locale, t } from '@strata/i18n';
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** pdf.js only for a PDF the WebView cannot show itself (ADR-0013). */
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })));

/**
 * The WebView shows a PDF in a frame itself (WebView2, WKWebView); where it
 * cannot — WebKitGTK, a browser without the viewer — pdf.js draws it (☑ Q-06-24).
 */
export function ownPdfViewer(): boolean {
  return navigator.pdfViewerEnabled === true;
}

/** Room kept between the window and the panels or the canvas's edge, CSS px. */
const GAP = 8;

/** What the viewer shows: an asset's types with a picture or a player (05 §4.4). */
export type Viewable = 'image' | 'video' | 'audio' | 'pdf';

export function viewable(type: string): type is Viewable {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'pdf';
}

/**
 * An asset's viewer (06 §13.1, §13.4): a retro window beside its bubble — a
 * picture to its size within the canvas, a video or sound with its player, a
 * PDF at the board's size, in the WebView's own viewer or drawn by pdf.js. The panel keeps the
 * small preview; this is the large one. While the focus is inside, the
 * canvas's keys are off; `Esc` gives the keyboard back to the canvas and
 * leaves the window and the selection, × closes the window.
 */
export function AssetWindow(props: {
  locale: Locale;
  name: string;
  type: Viewable;
  /** The file as an object URL, typed; null while it loads. */
  url: string | null;
  /** The file itself, for pdf.js; null while it loads. */
  file: Blob | null;
  /** Screen point of the bubble's side and which side the window opens on. */
  at: { x: number; y: number; side: 'left' | 'right' };
  /** The focus came in or went out: inside, the canvas's keys are off. */
  onFocus: (inside: boolean) => void;
  onEscape: () => void;
  onClose: () => void;
}) {
  const { locale, type, url, file } = props;
  const [own] = useState(ownPdfViewer);
  const title = props.name || t(locale, 'note.untitled');
  const ref = useRef<HTMLElement>(null);
  /** Where it settled once its content had a size: inside the free canvas. */
  const [place, setPlace] = useState<{ left: number; top: number; max: number } | null>(null);
  // The canvas runs under «Ноды» and the panel: the window stays between them.
  const settle = useCallback(() => {
    const el = ref.current;
    const host = el?.offsetParent;
    if (!el || !(host instanceof HTMLElement) || type === 'pdf') return;
    const h = host.getBoundingClientRect();
    const lo = (host.querySelector('.ws-layers')?.getBoundingClientRect().right ?? h.left) + GAP;
    const hi = (host.querySelector('.ws-inspector')?.getBoundingClientRect().left ?? h.right) - GAP;
    const r = el.getBoundingClientRect();
    const width = Math.min(r.width, hi - lo);
    const left = Math.min(Math.max(r.left, lo), hi - width) - h.left;
    const top = Math.min(Math.max(r.top, h.top + GAP), h.bottom - r.height - GAP) - h.top;
    setPlace({ left, top: Math.max(GAP, top), max: hi - lo });
  }, [type]);
  // Before the first paint and again when the content's size changed it.
  useLayoutEffect(() => {
    if (place === null) settle();
  }, [place, settle]);
  // A PDF takes the board's share of the canvas, not a place beside the bubble.
  const style: CSSProperties | undefined =
    type === 'pdf'
      ? undefined
      : place
        ? { left: place.left, top: place.top, maxWidth: place.max }
        : props.at.side === 'right'
          ? { left: props.at.x, top: props.at.y }
          : { right: `calc(100% - ${props.at.x}px)`, top: props.at.y };
  return (
    <section
      ref={ref}
      className="window asset-window"
      data-type={type}
      style={style}
      aria-label={t(locale, 'asset.label', { name: title })}
      // A click inside takes the focus here, so Esc is the window's, not the canvas's.
      tabIndex={-1}
      onFocusCapture={() => props.onFocus(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onFocus(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onEscape();
        }
      }}
    >
      <header className="window-title">
        <h2 title={title}>{title}</h2>
        <button
          type="button"
          className="window-close"
          aria-label={t(locale, 'asset.close')}
          title={t(locale, 'asset.close')}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div className="asset-body">
        {/* Placed again once the picture or the video knows its size. */}
        {url && type === 'image' ? (
          <img src={url} alt={title} onLoad={() => setPlace(null)} />
        ) : null}
        {url && type === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: the user's own file has no captions
          <video src={url} controls onLoadedMetadata={() => setPlace(null)} />
        ) : null}
        {url && type === 'audio' ? (
          // biome-ignore lint/a11y/useMediaCaption: the user's own file has no captions
          <audio src={url} controls />
        ) : null}
        {url && type === 'pdf' && own ? <iframe src={url} title={title} /> : null}
        {file && type === 'pdf' && !own ? (
          <Suspense fallback={null}>
            <PdfView locale={locale} title={title} file={file} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
