import type { NodeDetails, TrashPreview } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import { useEffect, useRef } from 'react';
import { Glyph } from '../TabBar';
import { pathLabel } from './paths';

/**
 * What a removal asks first (05 §5, 06 §12.3). «Удалить везде» of a node
 * placed in several networks: those networks, ⌂ the primary. A network
 * going to the trash with what is inside: how many go with it, and which
 * nodes stay where else they lie. One window for the whole selection;
 * `Esc` and «Отмена» take nothing.
 */
export function DeleteDialog(props: {
  locale: Locale;
  everywhere: boolean;
  /** The chosen nodes placed in several networks, with their places. */
  placed: readonly NodeDetails[];
  preview: TrashPreview;
  /** How many nodes were chosen. */
  chosen: number;
  onConfirm: (everywhere: boolean) => void;
  onCancel: () => void;
}) {
  const { locale, everywhere, placed, preview } = props;
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  const title = t(locale, everywhere ? 'del.everywhere' : 'del.trash');
  const inside = Math.max(0, preview.trashed.length - props.chosen);
  // One node's places need no name per row: the line above names it.
  const many = placed.length > 1;
  return (
    <div className="dialog-backdrop">
      <section
        className="window dialog delete-dialog"
        role="alertdialog"
        aria-labelledby="delete-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onCancel();
        }}
      >
        <header className="window-title">
          <h2 id="delete-title" title={title}>
            {title}
          </h2>
        </header>
        <div className="window-body">
          {placed.length > 0 ? (
            <>
              <p className="dialog-text">
                {many
                  ? t(locale, 'del.placedMany', { n: placed.length })
                  : t(locale, 'del.placed', {
                      name: placed[0]?.name ?? '',
                      n: placed[0]?.places.length ?? 0,
                    })}
              </p>
              <ul className="delete-list">
                {placed.flatMap((d) =>
                  d.places.map((p) => {
                    const path = pathLabel(p.path);
                    const row = many ? `${d.name} · ${path}` : path;
                    const role = t(locale, p.primary ? 'ins.placePrimary' : 'ins.placeAppearance');
                    return (
                      <li key={`${d.id}:${p.net}`}>
                        <span className="place-mark" title={role} role="img" aria-label={role}>
                          <Glyph name={p.primary ? 'home' : 'shortcut'} />
                        </span>
                        <span className="delete-row" title={row}>
                          {row}
                        </span>
                      </li>
                    );
                  }),
                )}
              </ul>
            </>
          ) : null}
          {inside > 0 ? (
            <p className="dialog-text">{t(locale, 'del.inside', { n: inside })}</p>
          ) : null}
          {preview.staying.length > 0 ? (
            <>
              <p className="dialog-text">
                {t(locale, 'del.staying', { n: preview.staying.length })}
              </p>
              <ul className="delete-list">
                {preview.staying.map((s) => {
                  const row = `${s.name} · ${pathLabel(s.path)}`;
                  return (
                    <li key={s.id}>
                      <span className="delete-row" title={row}>
                        {row}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={props.onCancel}>
              {t(locale, 'del.cancel')}
            </button>
            {everywhere && placed.length > 0 ? (
              <button type="button" onClick={() => props.onConfirm(false)}>
                {t(locale, 'del.onlyHere')}
              </button>
            ) : null}
            <button
              ref={confirm}
              type="button"
              className="is-default"
              onClick={() => props.onConfirm(everywhere)}
            >
              {t(locale, everywhere ? 'del.confirmEverywhere' : 'del.confirmTrash')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
