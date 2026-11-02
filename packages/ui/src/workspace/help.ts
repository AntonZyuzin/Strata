import type { MessageKey } from '@strata/i18n';

/**
 * «Клавиши» (06 §17): what the help window `?` lists, group by group, as
 * the MVP has it. A row's keys are alternatives; an alternative is tokens
 * joined by «+»: a key as it is printed, a modifier named as the OS names
 * it (`Mod` — `Ctrl`, `Cmd` on macOS: 06 §17), a gesture (`@…`) in words of
 * the UI's language.
 */
export interface HelpRow {
  label: MessageKey;
  keys: readonly (readonly string[])[];
  /** The desktop's only: a browser keeps the key (`Ctrl+W` closes its tab, 06 §13.1). */
  desktop?: boolean;
}

export interface HelpGroup {
  title: MessageKey;
  rows: readonly HelpRow[];
}

const row = (label: MessageKey, ...keys: (readonly string[])[]): HelpRow => ({ label, keys });

export const HELP: readonly HelpGroup[] = [
  {
    title: 'help.g.camera',
    rows: [
      row('help.pan', ['@mmbDrag'], ['Space', '@lmbDrag'], ['Shift', '@arrows']),
      row('help.zoom', ['@wheel'], ['='], ['−'], ['0']),
      row('help.fitAll', ['H']),
      row('help.frame', ['G'], ['F']),
      row('help.minimap', ['O']),
      row('help.map', ['M']),
    ],
  },
  {
    title: 'help.g.nav',
    rows: [
      row('help.dive', ['Enter'], ['I'], ['@double']),
      row('help.openFull', ['Shift', 'Enter']),
      row('help.openDocked', ['Mod', 'Enter']),
      { ...row('help.closeWindow', ['Mod', 'W']), desktop: true },
      row('help.up', ['U']),
      row('help.back', ['Alt', '←'], ['Alt', '→']),
      row('help.previous', ['`']),
      row('help.marks', ['Mod', '1…5'], ['1…5']),
      row('help.chain', ['PgUp'], ['PgDn'], ['Shift', 'PgUp'], ['Shift', 'PgDn']),
      row('help.arrows', ['@arrows']),
      row('help.goTo', ['Mod', 'O']),
      row('help.find', ['Mod', 'F']),
      row('help.palette', ['Mod', 'P']),
      row('help.help', ['?']),
    ],
  },
  {
    title: 'help.g.create',
    rows: [
      row('help.tab', ['Tab'], ['@doubleEmpty']),
      row('help.sibling', ['Shift', 'Tab']),
      row('help.rename', ['F2']),
      row('help.wrap', ['Shift', 'C']),
    ],
  },
  {
    title: 'help.g.wires',
    rows: [
      row('help.connect', ['@rimDrag']),
      row('help.chainStroke', ['J', '@stroke']),
      row('help.cut', ['Y', '@stroke'], ['Mod', '@rmbStroke']),
      row('help.fork', ['Shift', '@wireDrag']),
      row('help.noInsert', ['@hold8']),
      row('help.wireStyle', ['Shift', 'S']),
      row('help.extract', ['@shake'], ['Mod', 'Shift', 'X']),
      row('help.selectWire', ['Alt', 'PgDn'], ['Alt', 'PgUp']),
    ],
  },
  {
    title: 'help.g.edit',
    rows: [
      row('help.remove', ['Delete']),
      row('help.removeAll', ['Shift', 'Delete']),
      row('help.copyDrag', ['Alt', '@drag']),
      row('help.appearDrag', ['Alt', 'Mod', 'Shift', '@drag']),
      row('help.duplicate', ['Mod', 'D']),
      row('help.clipboard', ['Mod', 'C'], ['Mod', 'X'], ['Mod', 'V']),
      row('help.pasteAppearance', ['Mod', 'Shift', 'V']),
      row('help.undo', ['Mod', 'Z'], ['Mod', 'Shift', 'Z']),
      row('help.nudge', ['Mod', '@arrows'], ['Mod', 'Shift', '@arrows']),
    ],
  },
  {
    title: 'help.g.select',
    rows: [
      row('help.select', ['@click'], ['Shift', '@click'], ['Mod', '@click']),
      row('help.marquee', ['@emptyDrag'], ['S', '@drag']),
      row('help.branch', ['Alt', 'Shift', '@click'], ['Alt', 'Mod', '@click']),
      row('help.all', ['Mod', 'A']),
      row('help.none', ['Esc']),
    ],
  },
  {
    title: 'help.g.flags',
    rows: [
      row('help.flags', ['R'], ['Q'], ['E']),
      row('help.color', ['C']),
      row('help.icon', ['Z']),
      row('help.panel', ['P']),
      row('help.card', ['@mmbHold'], ['Shift', 'I'], ['@ringInfo']),
    ],
  },
  {
    title: 'help.g.layout',
    rows: [row('help.layout', ['L']), row('help.arrange', ['A', '@drag'])],
  },
];

/** The OS's names of the modifiers (06 §17: ⌘, ⌥, ⇧ on macOS). */
export function keyName(token: string, mac: boolean): string {
  switch (token) {
    case 'Mod':
      return mac ? '⌘' : 'Ctrl';
    case 'Alt':
      return mac ? '⌥' : 'Alt';
    case 'Shift':
      return mac ? '⇧' : 'Shift';
    default:
      return token;
  }
}

/** Is this the macOS keyboard, whose modifiers have their own signs. */
export function onMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
