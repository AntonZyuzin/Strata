import {
  IMPORT_SECTIONS,
  type ImportCounts,
  type ImportItem,
  type ImportReport,
} from '@strata/backend';
import type { GlyphName } from '@strata/design-tokens';
import { type Locale, type MessageKey, t } from '@strata/i18n';
import { type ReactNode, useEffect, useRef } from 'react';
import { Icon, type IconName } from '../icons/Icon';
import { Glyph } from '../TabBar';

/**
 * What came in, in this order: an icon and a number, the words in the
 * tooltip. Ghosts and skipped files are counted by their sections below:
 * one fact once (owner, 2026-10-24).
 */
const COUNTS: readonly [keyof ImportCounts, { icon: IconName } | { glyph: GlyphName }][] = [
  ['notes', { icon: 'note' }],
  ['tasks', { icon: 'task' }],
  ['lists', { icon: 'checklist' }],
  ['boards', { icon: 'board' }],
  ['folders', { icon: 'network' }],
  ['canvases', { icon: 'networkOpen' }],
  ['assets', { icon: 'filetype-image' }],
  ['wires', { glyph: 'line' }],
];

/** Seriousness as icons, never red: red is for overdue only (07, 13 §3.6). */
const SEVERITY: Record<ImportItem['severity'], GlyphName> = {
  info: 'dash',
  warn: 'bang',
  error: 'cross',
};

/** A line of the report in the UI's language. */
export function itemText(locale: Locale, item: ImportItem): string {
  return t(locale, `import.item.${item.code}` as MessageKey, { detail: item.detail ?? '' });
}

/**
 * The report of an import (13 §3.6, S1 step 7): what came in, then the
 * sections — ghosts, ambiguous links, unsupported syntax, changed names,
 * properties, canvases, skipped files. A line with a node goes to it (09
 * §3.4). Opens over the canvas once the vault is in; `Ctrl+P` «Отчёт
 * импорта» opens it again. A window of fixed width in `ch`.
 */
export function ImportReportWindow(props: {
  locale: Locale;
  report: ImportReport;
  onGo: (node: string) => void;
  onClose: () => void;
}) {
  const { locale, report } = props;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const title = t(locale, 'import.title');
  const counts = COUNTS.filter(([k]) => report.counts[k] > 0);
  return (
    <div className="dialog-backdrop">
      <section
        className="window import-report"
        role="dialog"
        aria-labelledby="import-title"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onClose();
        }}
      >
        <header className="window-title">
          <h2 id="import-title" title={title}>
            {title}
          </h2>
          <button
            ref={close}
            type="button"
            className="window-close"
            aria-label={t(locale, 'import.close')}
            title={t(locale, 'import.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="window-body import-body">
          <ul className="import-counts">
            {counts.map(([k, look]) => {
              const words = t(locale, `import.count.${k}` as MessageKey, { n: report.counts[k] });
              return (
                <li key={k} title={words} aria-label={words}>
                  {'icon' in look ? <Icon name={look.icon} /> : <Glyph name={look.glyph} />}
                  <span aria-hidden="true">{report.counts[k]}</span>
                </li>
              );
            })}
          </ul>
          {report.items.length === 0 ? (
            <p className="dialog-text import-none">{t(locale, 'import.none')}</p>
          ) : null}
          {IMPORT_SECTIONS.map((section) => {
            const items = report.items.filter((i) => i.section === section);
            if (items.length === 0) return null;
            return (
              <Section
                key={section}
                title={t(locale, `import.section.${section}` as MessageKey)}
                n={items.length}
              >
                {items.map((item, i) => {
                  const text = itemText(locale, item);
                  const severity = t(locale, `import.severity.${item.severity}` as MessageKey);
                  const node = item.node;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id; their order is fixed
                    <li key={i}>
                      <button
                        type="button"
                        className="import-row"
                        disabled={!node}
                        onClick={() => node && props.onGo(node)}
                      >
                        <span
                          className="import-severity"
                          title={severity}
                          role="img"
                          aria-label={severity}
                        >
                          <Glyph name={SEVERITY[item.severity]} />
                        </span>
                        <span className="import-text" title={text}>
                          {text}
                        </span>
                        <span className="import-path" title={item.path}>
                          {item.path}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </Section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Section(props: { title: string; n: number; children: ReactNode }) {
  return (
    <section className="import-section">
      <h3 title={props.title}>
        {props.title}
        <span className="import-n">{props.n}</span>
      </h3>
      <ul className="import-list">{props.children}</ul>
    </section>
  );
}
