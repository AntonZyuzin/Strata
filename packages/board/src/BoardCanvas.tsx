/// <reference path="./css.d.ts" />
import {
  CaptureUpdateAction,
  Excalidraw,
  FONT_FAMILY,
  newElementWith,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import { palette } from '@strata/design-tokens';
import type { LoroDoc } from 'loro-crdt';
import { useEffect, useMemo, useRef } from 'react';
import {
  type BoardElement,
  type BoardFile,
  LOCAL,
  readElements,
  readFiles,
  reconcile,
  writeFiles,
  writeLocal,
} from './binding';
import type { BoardPaint, BoardTool } from './tools';

/**
 * The board's canvas (ADR-0006): Excalidraw on a pinned `next` snapshot,
 * imported only in this package (15 §2.3). No Excalidraw UI (`ui={false}`):
 * Strata's window and toolbar drive it. Light theme on a transparent
 * background, so the Fog shows through and colours are not inverted; strict
 * look by default (☑ Q-15-6): no roughness, paper lines, Nunito.
 *
 * The scene lives in the board's content document (binding.ts): durable
 * increments write the touched elements, imported changes merge in with
 * Excalidraw's rule and do not enter local undo. Images (dropped or pasted)
 * are files beside the elements, written once by their id.
 *
 * The tool is the host's (`activeTool`, controlled): Strata's toolbar is the
 * only switch, and a tool stays on after use, as with Excalidraw's lock,
 * until another one is picked.
 */

type Elements = Parameters<ExcalidrawImperativeAPI['updateScene']>[0]['elements'];

/** What tests and the app read of a live board. */
export interface BoardHandle {
  /** The scene's elements, deleted ones excluded, in z-order. */
  elements(): BoardElement[];
  /** Excalidraw's active tool. */
  activeTool(): string;
  /** Ids of the files (images) the scene holds. */
  files(): string[];
  /**
   * Centres the viewport on scene point (x, y) at `zoom` (the benchmark's
   * camera). `gesture`: as Excalidraw's own wheel and pinch do, element
   * caches are not rebuilt for every step of the zoom until it ends.
   */
  view(x: number, y: number, zoom: number, gesture?: boolean): void;
  /**
   * A colour from the palette (07 §8.4): the selected elements take it, with
   * the texts bound to them for the line, as Excalidraw's own panel does, and
   * so do the next ones drawn. One step of undo.
   */
  paint(which: BoardPaint, color: string): void;
}

export function BoardCanvas(props: {
  doc: LoroDoc;
  tool: BoardTool;
  /** The scene changed locally (for saving). */
  onChange?: () => void;
  /** The board is ready: its handle. */
  onReady?: (handle: BoardHandle) => void;
}) {
  const { doc, tool } = props;
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const changed = useRef(props.onChange);
  changed.current = props.onChange;
  /** Ids of the files the document holds. */
  const stored = useRef(new Set<string>());
  const initial = useMemo(() => {
    const files = readFiles(doc);
    stored.current = new Set(files.map((f) => f.id));
    return {
      elements: readElements(doc) as unknown as NonNullable<Elements>,
      files: Object.fromEntries(files.map((f) => [f.id, f])) as unknown as BinaryFiles,
      appState: {
        viewBackgroundColor: 'transparent',
        currentItemStrokeColor: palette.paper,
        currentItemRoughness: 0,
        currentItemFontFamily: FONT_FAMILY.Nunito,
      },
      scrollToContent: true,
    };
  }, [doc]);

  // Imported changes → the scene, with Excalidraw's rule; newer local ones go back.
  useEffect(
    () =>
      doc.subscribe((e) => {
        const a = api.current;
        if (!a || e.by !== 'import') return;
        const st = a.getAppState();
        const editing = new Set<string>();
        if (st.cursorButton === 'down') {
          for (const id of Object.keys(st.selectedElementIds)) editing.add(id);
        }
        if (st.editingTextElement) editing.add(st.editingTextElement.id);
        const local = a.getSceneElementsIncludingDeleted() as unknown as BoardElement[];
        const merged = reconcile(local, readElements(doc), editing);
        a.updateScene({
          elements: merged.elements as unknown as Elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        writeLocal(doc, merged.elements, merged.writeBack);
        const shown = a.getFiles();
        const fresh = readFiles(doc).filter((f) => !shown[f.id]);
        for (const f of fresh) stored.current.add(f.id);
        if (fresh.length > 0) a.addFiles(fresh as unknown as BinaryFileData[]);
      }),
    [doc],
  );

  return (
    <Excalidraw
      ui={false}
      theme="light"
      handleKeyboardGlobally={false}
      initialData={initial}
      onExcalidrawAPI={(a) => {
        api.current = a;
        // `null` on unmount.
        if (!a) return;
        props.onReady?.({
          paint: (which, color) => {
            const st = a.getAppState();
            const picked = new Set(
              Object.entries(st.selectedElementIds).flatMap(([id, on]) => (on ? [id] : [])),
            );
            if (st.editingTextElement) picked.add(st.editingTextElement.id);
            let touched = false;
            const elements = a.getSceneElementsIncludingDeleted().map((e) => {
              const bound = which === 'stroke' && e.type === 'text' && e.containerId;
              const hit = picked.has(e.id) || (bound && picked.has(bound));
              const now = which === 'stroke' ? e.strokeColor : e.backgroundColor;
              if (!hit || e.isDeleted || now === color) return e;
              touched = true;
              return newElementWith(
                e,
                which === 'stroke' ? { strokeColor: color } : { backgroundColor: color },
              );
            });
            a.updateScene({
              appState: {
                currentItemStrokeColor: which === 'stroke' ? color : st.currentItemStrokeColor,
                currentItemBackgroundColor:
                  which === 'fill' ? color : st.currentItemBackgroundColor,
              },
              ...(touched ? { elements } : {}),
              captureUpdate: touched ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
            });
          },
          elements: () => a.getSceneElements() as unknown as BoardElement[],
          activeTool: () => a.getAppState().activeTool.type,
          files: () => Object.keys(a.getFiles()),
          view: (x, y, zoom, gesture = false) => {
            const st = a.getAppState();
            // Excalidraw: screen = (scene + scroll) × zoom.
            a.updateScene({
              appState: {
                zoom: { value: zoom as AppState['zoom']['value'] },
                scrollX: st.width / 2 / zoom - x,
                scrollY: st.height / 2 / zoom - y,
                shouldCacheIgnoreZoom: gesture,
              },
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          },
        });
      }}
      activeTool={{ type: tool }}
      onChange={(_elements, _state, files) => {
        const fresh = Object.values(files).filter((f) => !stored.current.has(f.id));
        if (fresh.length === 0) return;
        for (const f of fresh) stored.current.add(f.id);
        if (writeFiles(doc, fresh as unknown as BoardFile[]) > 0) changed.current?.();
      }}
      onIncrement={(inc) => {
        const a = api.current;
        if (!a || inc.type !== 'durable' || !('delta' in inc)) return;
        const d = inc.delta.elements;
        const ids = [...Object.keys(d.added), ...Object.keys(d.removed), ...Object.keys(d.updated)];
        if (ids.length === 0) return;
        const n = writeLocal(
          doc,
          a.getSceneElementsIncludingDeleted() as unknown as BoardElement[],
          ids,
        );
        if (n > 0) changed.current?.();
      }}
    />
  );
}

export { LOCAL };
