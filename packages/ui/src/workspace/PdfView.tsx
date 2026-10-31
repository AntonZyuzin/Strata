import { type Locale, t } from '@strata/i18n';
import { useEffect, useRef, useState } from 'react';

/** pdf.js and its worker, loaded with the first PDF a WebView cannot show itself. */
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

let pdfjs: Promise<PdfJs> | null = null;

/**
 * The legacy build: the modern one wants `Promise.withResolvers` (Safari
 * 17.4), and this path is for WebViews without a viewer of their own, such
 * as an older WebKitGTK (ADR-0013).
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/** The files pdf.js fetches beside its code, shipped with the app (vite.config.ts). */
const at = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/**
 * A PDF drawn by pdf.js (06 §13.4, ☑ Q-06-24) where the WebView has no
 * viewer of its own: every page fits the window's width, one under another;
 * a page is drawn when it comes near the view, at the screen's pixel ratio.
 * Scroll by the wheel or the keys once the pages have the focus.
 */
export function PdfView(props: { locale: Locale; title: string; file: Blob }) {
  const { locale, file } = props;
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  /** Each page's height over its width, the first page's until a page is read. */
  const [ratios, setRatios] = useState<number[]>([]);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let live = true;
    let task: ReturnType<PdfJs['getDocument']> | null = null;
    void (async () => {
      const lib = await loadPdfJs();
      const data = new Uint8Array(await file.arrayBuffer());
      if (!live) return;
      task = lib.getDocument({
        data,
        cMapUrl: at('cmaps'),
        standardFontDataUrl: at('standard_fonts'),
        wasmUrl: at('wasm'),
        iccUrl: at('iccs'),
        enableXfa: false,
      });
      const opened = await task.promise;
      const first = (await opened.getPage(1)).getViewport({ scale: 1 });
      if (!live) return;
      setRatios(Array.from({ length: opened.numPages }, () => first.height / first.width));
      setDoc(opened);
    })().catch(() => {
      if (live) setFailed(true);
    });
    // The worker and the document go with the window.
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [file]);

  // Pages fit the width the window gives them.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const pad = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      setWidth(Math.max(0, Math.floor(inner)));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  if (failed) {
    return <div className="pdf-failed">{t(locale, 'asset.pdfFailed')}</div>;
  }
  return (
    <div
      ref={box}
      className="pdf-view"
      role="document"
      aria-label={props.title}
      aria-busy={doc === null}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the pages scroll by the keys
      tabIndex={0}
    >
      {doc && width > 0
        ? ratios.map((ratio, i) => (
            <PdfPage
              // biome-ignore lint/suspicious/noArrayIndexKey: a page is its number
              key={i}
              doc={doc}
              index={i + 1}
              width={width}
              ratio={ratio}
              root={box}
              onRatio={(r) =>
                setRatios((all) => (all[i] === r ? all : all.map((x, k) => (k === i ? r : x))))
              }
            />
          ))
        : null}
    </div>
  );
}

function PdfPage(props: {
  doc: PdfDocument;
  index: number;
  width: number;
  ratio: number;
  root: React.RefObject<HTMLDivElement | null>;
  onRatio: (ratio: number) => void;
}) {
  const { doc, index, width } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const onRatio = useRef(props.onRatio);
  onRatio.current = props.onRatio;

  // Drawn once it is within a screen of the view.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: props.root.current, rootMargin: '100% 0px' },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [props.root]);

  useEffect(() => {
    const el = canvas.current;
    if (!near || !el || width <= 0) return;
    let live = true;
    let cancel: (() => void) | null = null;
    void (async () => {
      const page = await doc.getPage(index);
      if (!live) return;
      const base = page.getViewport({ scale: 1 });
      onRatio.current(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      el.width = Math.round(viewport.width);
      el.height = Math.round(viewport.height);
      const task = page.render({ canvas: el, viewport });
      cancel = () => task.cancel();
      await task.promise;
      el.dataset.drawn = 'true';
    })().catch(() => undefined);
    return () => {
      live = false;
      cancel?.();
    };
  }, [near, doc, index, width]);

  return (
    <canvas
      ref={canvas}
      className="pdf-page"
      data-page={index}
      style={{ width, height: Math.round(width * props.ratio) }}
    />
  );
}
