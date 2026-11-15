import { describe, expect, it } from 'vitest';
import { NAME_MAX, pastedNote } from './pasted';

describe('text pasted as a note (06 §12.1, 13 §3.9)', () => {
  it('keeps the text inside and names the note by its first line', () => {
    expect(pastedNote('Хлеб', 'Без имени')).toEqual({ name: 'Хлеб', body: 'Хлеб' });
    expect(pastedNote('# Покупки\n\nкупить [[Хлеб]]\nи молоко', 'Без имени')).toEqual({
      name: 'Покупки',
      body: '# Покупки\n\nкупить [[Хлеб]]\nи молоко',
    });
  });

  it('takes the marks of Markdown off the name, never off the body', () => {
    const name = (text: string) => pastedNote(text, '?').name;
    expect(name('- [ ] позвонить маме')).toBe('позвонить маме');
    expect(name('> цитата дня')).toBe('цитата дня');
    expect(name('1. первый шаг')).toBe('первый шаг');
    expect(name('см. [[Хлеб|хлеба]] и [[Молоко]]')).toBe('см. хлеба и Молоко');
    expect(pastedNote('- [ ] позвонить', '?').body).toBe('- [ ] позвонить');
  });

  it('cuts a long first line at a word, within the limit', () => {
    const text =
      'Сегодня мы обсуждали планы на следующий квартал и решили перенести релиз на весну';
    const { name, body } = pastedNote(text, '?');
    expect([...name].length).toBeLessThanOrEqual(NAME_MAX);
    expect(name).toBe('Сегодня мы обсуждали планы на следующий квартал…');
    expect(body).toBe(text);
    // One long word: cut where the limit is.
    expect([...pastedNote('а'.repeat(80), '?').name].length).toBe(NAME_MAX);
  });

  it('names by the first line with words; a note of no words is untitled', () => {
    expect(pastedNote('\n\n  \nВторая строка\nтретья', '?')).toEqual({
      name: 'Вторая строка',
      body: 'Вторая строка\nтретья',
    });
    expect(pastedNote('# ', 'Без имени').name).toBe('Без имени');
  });
});
