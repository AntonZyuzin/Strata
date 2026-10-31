import type { ImportProgress } from '@strata/backend';
import { formatNumber, type Locale, t } from '@strata/i18n';
import { IconButton } from '../TabBar';

/** Segments of the track (07 §8.2): one is 5 % of the files. */
const SEGMENTS = 20;

/**
 * An import going on (13 §3.3, S1 step 5): «Импорт: 1 840 из 3 200» and a
 * segmented track, the last line of the toasts at the foot of the canvas,
 * while the batches land and the networks appear behind it; the cross stops
 * the import, its workspace going with it. Before the first batch — the
 * vault being read and planned.
 */
export function ImportStatus(props: {
  locale: Locale;
  progress: ImportProgress;
  onCancel: () => void;
}) {
  const { locale, progress } = props;
  const planned = progress.total > 0;
  const text = planned
    ? t(locale, 'import.progress', {
        done: formatNumber(locale, progress.done),
        total: formatNumber(locale, progress.total),
      })
    : t(locale, 'import.planning');
  const on = planned ? Math.floor((progress.done / progress.total) * SEGMENTS) : 0;
  return (
    <li className="toast ws-import" role="status">
      <span className="ws-import-text" title={text}>
        {text}
      </span>
      <span className="progress-track" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place
          <i key={i} className={i < on ? 'is-on' : undefined} />
        ))}
      </span>
      <IconButton icon="close" label={t(locale, 'import.cancel')} onClick={props.onCancel} />
    </li>
  );
}
