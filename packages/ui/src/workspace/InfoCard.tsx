import type { NodeDetails } from '@strata/backend';
import { useLayoutEffect, useRef } from 'react';
import { type CardItem, type CardWords, fullCard } from '../proto/map-cards';

/** CSS px between the card and the canvas's edges. */
const MARGIN = 8;

/**
 * The info card on the canvas (06 §4.4, glossary «Инфокарточка»): the star
 * map's full card (08 §6.2, `fullCard`) beside a bubble — while the middle
 * button holds it, after the cursor rested 600 ms on it, or kept by
 * `Shift+I` with the accent's line under its title until its ×. Right of
 * the bubble, left of it when the right has no room, kept inside the canvas
 * one sees. The fields come from the core; until then, the name and kind.
 */
export function InfoCard(props: {
  item: CardItem;
  details: NodeDetails | null;
  words: CardWords;
  person: (id: string) => string | undefined;
  /** Key nodes (05 §7) inside a folder or project, at most five. */
  keys: readonly string[];
  /** The bubble's right side and its middle in height, page px. */
  x: number;
  y: number;
  /** The bubble's left side, page px: the card's right edge when it flips. */
  flipX: number;
  bounds?: DOMRect | undefined;
  kept: boolean;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // What changes from render to render but not what the card says.
  const live = useRef(props);
  live.current = props;
  const keys = props.keys.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` holds the callbacks and the bounds
  useLayoutEffect(() => {
    const h = host.current;
    if (!h) return;
    const p = live.current;
    const card = fullCard(p.item, p.details, p.words, {
      person: (id) => live.current.person(id),
      keys: p.keys,
      onClose: () => live.current.onClose(),
    });
    card.classList.add('ws-info-card');
    card.classList.toggle('is-kept', p.kept);
    h.replaceChildren(card);
    const w = card.offsetWidth;
    const ht = card.offsetHeight;
    const b = p.bounds;
    const left = (b?.left ?? 0) + MARGIN;
    const top = (b?.top ?? 0) + MARGIN;
    const right = (b?.right ?? window.innerWidth) - MARGIN;
    const bottom = (b?.bottom ?? window.innerHeight) - MARGIN;
    const x = p.x + w <= right ? p.x : p.flipX - w >= left ? p.flipX - w : right - w;
    card.style.left = `${Math.max(left, x)}px`;
    card.style.top = `${Math.max(top, Math.min(p.y - ht / 2, bottom - ht))}px`;
  }, [
    props.item.id,
    props.item.name,
    props.item.kind,
    props.details,
    props.words.locale,
    props.words.date,
    keys,
    props.x,
    props.y,
    props.flipX,
    props.kept,
  ]);
  return <div ref={host} className="ws-info" />;
}
