import { type GlyphName, glyphUrl } from '@strata/design-tokens';
import { type Locale, t } from '@strata/i18n';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';

/**
 * The app's bar, a retro browser's (✅ Q-16-12): the logo goes home, two
 * icon tools — import and export — then the tabs of open workspaces and «+»
 * right after the last tab. The tools sit on a raised strip, the tabs on the
 * darker ground below it, so the two never read as one row of buttons.
 */

export interface Tab {
  id: string;
  name: string;
}

/** A 1-bit glyph of 07 §6.2 in the current text colour. */
export function Glyph(props: { name: GlyphName }) {
  return (
    <span
      className="kind-icon"
      style={{ '--glyph': glyphUrl(props.name) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** A square button with an icon; its name is the tooltip and the accessible name. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** A toggle: shown pressed, said pressed. */
  pressed?: boolean | undefined;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={['icon-button', props.className].filter(Boolean).join(' ')}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {props.children}
    </button>
  );
}

export function TabBar(props: {
  locale: Locale;
  tabs: Tab[];
  /** The open workspace; null on the home screen. */
  active: string | null;
  onHome: () => void;
  onImport: () => void;
  /** Absent on the home screen: there a card exports itself. */
  onExport: (() => void) | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Undo and redo of the open workspace, its star map; absent on the home screen. */
  undo: { canUndo: boolean; canRedo: boolean; step: string; map: boolean } | undefined;
  onUndo: () => void;
  onRedo: () => void;
  onMap: () => void;
}) {
  const { locale, active } = props;
  return (
    <nav className="tabbar" aria-label={t(locale, 'tabs.label')}>
      <button
        type="button"
        className="tabbar-logo"
        aria-label={t(locale, 'ws.home')}
        title={t(locale, 'ws.homeHint')}
        aria-current={active === null ? 'page' : undefined}
        onClick={props.onHome}
      >
        <Glyph name="logo" />
        <span aria-hidden="true">Strata</span>
      </button>
      <div className="tabbar-tools">
        <IconButton icon="import" label={t(locale, 'home.importHint')} onClick={props.onImport} />
        <IconButton
          icon="export"
          label={t(locale, 'home.exportHint')}
          disabled={!props.onExport}
          onClick={() => props.onExport?.()}
        />
        <span className="tabbar-gap" aria-hidden="true" />
        <IconButton
          icon="undo"
          label={props.undo?.canUndo ? props.undo.step : t(locale, 'proto.undo')}
          disabled={!props.undo?.canUndo}
          onClick={props.onUndo}
        />
        <IconButton
          icon="redo"
          label={t(locale, 'proto.redo')}
          disabled={!props.undo?.canRedo}
          onClick={props.onRedo}
        />
        <span className="tabbar-gap" aria-hidden="true" />
        <IconButton
          icon="map"
          className={props.undo?.map ? 'is-pressed' : undefined}
          label={t(locale, 'proto.view.hint')}
          pressed={props.undo?.map ?? false}
          disabled={!props.undo}
          onClick={props.onMap}
        />
      </div>
      <div className="tabbar-tabs" role="tablist" aria-label={t(locale, 'tabs.label')}>
        {props.tabs.map((tab) => (
          <div key={tab.id} className={tab.id === active ? 'tab is-active' : 'tab'}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              className="tab-name"
              title={tab.name}
              onClick={() => props.onSelect(tab.id)}
            >
              <Icon name="network" />
              <span className="tab-label">{tab.name}</span>
            </button>
            <IconButton
              icon="close"
              className="tab-close"
              label={t(locale, 'tabs.close', { name: tab.name })}
              onClick={() => props.onClose(tab.id)}
            />
          </div>
        ))}
        <IconButton
          icon="plus"
          className="tab-new"
          label={t(locale, 'home.new')}
          onClick={props.onNew}
        />
      </div>
    </nav>
  );
}
