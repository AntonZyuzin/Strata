import { useEffect, useState, useSyncExternalStore } from 'react';
import { onReadableApplied, readableApplied } from './pixel';
import type { ReadableMode } from './prefs';

/** What asks for the readable mode from the system (07 §11.4). */
const QUERIES = ['(prefers-contrast: more)', '(forced-colors: active)'] as const;

/** Whether the system asks for more contrast or forces its colours. */
export function systemAsksReadable(): boolean {
  return QUERIES.some((q) => window.matchMedia(q).matches);
}

/**
 * The readable mode in force (07 §11.4): on by hand, or «Как в системе» —
 * on while the system asks for more contrast or forces its colours.
 */
export function readableOn(mode: ReadableMode, system = systemAsksReadable()): boolean {
  return mode === 'on' || (mode === 'system' && system);
}

/**
 * Whether the document is in the readable mode now (07 §11.4): for what
 * draws icons — Phosphor's line drawings instead of pixel pictures.
 */
export function useReadableMode(): boolean {
  return useSyncExternalStore(onReadableApplied, readableApplied);
}

/** The readable mode in force, following the system's answer as it changes. */
export function useReadable(mode: ReadableMode): boolean {
  const [system, setSystem] = useState(systemAsksReadable);
  useEffect(() => {
    const lists = QUERIES.map((q) => window.matchMedia(q));
    const changed = () => setSystem(systemAsksReadable());
    for (const l of lists) l.addEventListener('change', changed);
    return () => {
      for (const l of lists) l.removeEventListener('change', changed);
    };
  }, []);
  return readableOn(mode, system);
}
