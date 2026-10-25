import type { NodeKind } from '@strata/backend';
import { type Locale, t } from '@strata/i18n';
import type { CSSProperties } from 'react';
import { Icon, nodeIcon } from '../icons/Icon';
import { Glyph } from '../TabBar';

/**
 * The path (✅ Q-06-25, 06 §10.2): where the canvas is, at its bottom left,
 * from depth 2. The workspace is the tab's icon only — the tab says its name — then
 * every folder and project with its icon; a click goes there. The network on
 * the canvas ends the path and is no button. One line: when room runs out the
 * names give way to their icons, each keeps its name as a tooltip, the bar
 * the whole path.
 */
export function PathBar(props: {
  locale: Locale;
  /** From the root to the network on the canvas: `[id, name]`. */
  path: readonly (readonly [string, string])[];
  kindOf: (id: string) => NodeKind;
  /** The properties panel is open: the path keeps left of it. */
  panel: boolean;
  onGo: (id: string) => void;
}) {
  const { path } = props;
  if (path.length < 2) return null;
  return (
    <nav
      className="ws-path"
      data-panel={props.panel ? 'open' : 'closed'}
      aria-label={t(props.locale, 'ws.path')}
      title={path.map(([, name]) => name).join(' / ')}
    >
      <ol style={{ '--ancestors': path.length - 2 } as CSSProperties}>
        {path.map(([id, name], i) => {
          // The workspace has the tab's icon; every folder on the way is open:
          // the canvas is inside it.
          const icon = <Icon name={nodeIcon(props.kindOf(id), {}, i > 0)} />;
          if (i === path.length - 1) {
            return (
              <li key={id} className="ws-path-here">
                <Glyph name="folded" />
                <span className="ws-path-step" aria-current="location">
                  {icon}
                  <span className="ws-path-name" title={name}>
                    {name}
                  </span>
                </span>
              </li>
            );
          }
          return (
            <li key={id} className={i === 0 ? 'ws-path-root' : undefined}>
              {i > 0 ? <Glyph name="folded" /> : null}
              <button
                type="button"
                className="ws-path-step"
                title={name}
                aria-label={name}
                onClick={() => props.onGo(id)}
              >
                {icon}
                {i > 0 ? (
                  <span className="ws-path-name" title={name}>
                    {name}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
