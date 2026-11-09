import { type Locale, t } from '@strata/i18n';
import { StartDialog } from './StartDialog';

/** Where the app asks for updates (the release workflow publishes there). */
const CHANNEL = 'github.com/AntonZyuzin/Strata';

/**
 * NFR-94: the app asks the network nothing without the person's leave. At
 * the first start of a build with an update channel (NFR-89) it asks once
 * whether to check; «Настройки» change the answer later.
 */
export function UpdateQuestion(props: { locale: Locale; onAnswer: (check: boolean) => void }) {
  const { locale } = props;
  return (
    <StartDialog
      id="update-ask"
      title={t(locale, 'updates.ask')}
      hint={t(locale, 'updates.askHint')}
      body={CHANNEL}
      cancel={t(locale, 'updates.never')}
      confirm={t(locale, 'updates.check')}
      onCancel={() => props.onAnswer(false)}
      onConfirm={() => props.onAnswer(true)}
    />
  );
}

/**
 * A newer version, found at the start (NFR-89): «Установить» downloads it,
 * the updater checks its signature and its version, installs it and starts
 * it; «Позже» — till the next start.
 */
export function UpdateOffer(props: {
  locale: Locale;
  version: string;
  /** The version running. */
  current: string;
  notes?: string | null | undefined;
  installing: boolean;
  onLater: () => void;
  onInstall: () => void;
}) {
  const { locale } = props;
  const title = t(locale, 'updates.found', { version: props.version });
  return (
    <StartDialog
      id="update-offer"
      title={title}
      hint={props.notes?.trim() || title}
      body={
        props.installing
          ? t(locale, 'updates.installing')
          : t(locale, 'updates.now', { version: props.current })
      }
      cancel={t(locale, 'updates.later')}
      confirm={t(locale, 'updates.install')}
      busy={props.installing}
      onCancel={props.onLater}
      onConfirm={props.onInstall}
    />
  );
}
