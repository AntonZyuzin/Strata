# @strata/gecko

Компаньон Strata — пиксельный гекон на холсте пространства ([07](../../docs/07-design-system.md) §10.4). React-компонент без зависимостей, кроме React.

## Происхождение и лицензия

- Рисунок — утверждённый владельцем лист из двенадцати поз (`assets/approved-reference.png`, 2026-10-24), сделан для Strata. Лицензия — лицензия репозитория (AGPL-3.0-or-later), как у своих значков Strata.
- Код перенесён из автономного прототипа владельца (папка вне репозитория, `strata-gecko`, демо `preview.html`) и доведён в Strata: риг на целых пикселях и RotSprite, перехваты на нити, строгие типы.

## Файлы

| Файл | Что |
|---|---|
| `GeckoCompanion.tsx` | React-слой: холст, ввод (клик — погладить, двойной — гулять, перетаскивание, стрелки, Esc), цикл отрисовки, пауза |
| `geckoEngine.ts` | Поведение без DOM: дом, прогулка, очередь реакций с приоритетами, сон, нити; тесты — `geckoEngine.test.ts` |
| `geckoRig.ts` | Позы режутся на части из пикселей рисунка; движения частей, три исполнения каждой анимации, перехват на нити |
| `geckoSprite.ts` | Вырезка поз, сборка кадра на сетке 96×72: швы — пикселями позы, поворот кадра — RotSprite, без оторванных пикселей |
| `geckoRotsprite.ts` | RotSprite: поворот пиксель-арта на любой угол (Scale2x ×3, выборка по центрам) |
| `geckoEffects.ts` | Сердечки, плюс, галочка, часы, «Zzz», «?», «!» над геконом |

## Как пользоваться

```tsx
<div style={{ position: 'relative' }}>
  <GeckoCompanion ref={gecko} label={t(locale, 'gecko.label')} hint={t(locale, 'gecko.hint')} />
</div>
gecko.current?.react('task-created');
```

События: `task-created`, `project-created`, `file-created`, `task-completed`, `nodes-linked`, `deadline-near`. В Strata их выбирает `packages/ui/src/workspace/gecko.ts` из шагов графа холста.

Что осталось — [HANDOFF.md](HANDOFF.md).
