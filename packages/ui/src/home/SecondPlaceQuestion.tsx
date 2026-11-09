import { type Locale, t } from '@strata/i18n';
import { StartDialog } from '../StartDialog';

/**
 * «Класть копии и во второе место?» (10 §3.5, NFR-73, ☑ Q-14-9): at the
 * first start on desktop, after the welcome and the updates' question. The
 * copies of a workspace lie in its folder and do not outlive its disk; a
 * folder on another disk or a network share takes them too. «Выбрать
 * папку…» opens the system's folder picker — a folder refused says why and
 * the question stays; «Не сейчас» answers it as well. Asked once: the
 * answer lives on the device, «Настройки» → «Копии» change it.
 */
export function SecondPlaceQuestion(props: {
  locale: Locale;
  busy: boolean;
  /** The folder refused, worded: the question stays for another choice. */
  error: string | null;
  onChoose: () => void;
  onLater: () => void;
}) {
  const { locale } = props;
  return (
    <StartDialog
      id="second-ask"
      title={t(locale, 'second.ask')}
      hint={t(locale, 'second.askHint')}
      body={t(locale, 'second.askBody')}
      cancel={t(locale, 'second.later')}
      confirm={t(locale, 'second.choose')}
      busy={props.busy}
      error={props.error}
      onCancel={props.onLater}
      onConfirm={props.onChoose}
    />
  );
}
