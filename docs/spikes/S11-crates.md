# Спайк 11. Совместимость с Obsidian — часть 1: крейты Rust

> Статус: **часть 1 — выбор крейтов** (2026-10-23). Пункт 7 из [13](../13-interop.md) §7.3: Rust-крейты для Markdown, YAML, LZString и JSON Canvas, которые нужны ядру — нити `text`, импорт и экспорт без UI ([15](../15-architecture.md) §2.6). Остальные пункты §7.3 — до MVP+ 1.2 ([16](../16-roadmap.md) §3.2). Связано: [15](../15-architecture.md) §2.6, §8.4, [16](../16-roadmap.md) шаг 0.5, [R2](../research/R2-obsidian-format.md).
>
> Код: [`crates/strata-markdown`](../../crates/strata-markdown) — чтение `[[ссылок]]`, embed, тегов и свойств на выбранных крейтах, с тестами.

## Выбор

| Задача | Крейт | Лицензия | Почему | Отклонены |
|---|---|---|---|---|
| Markdown | `pulldown-cmark` 0.13.5 | MIT | CommonMark с вики-ссылками Obsidian (`ENABLE_WIKILINKS`), YAML-блоком метаданных, callout-ами (`ENABLE_GFM`), сносками, формулами, задачами; события со смещениями в байтах — нить знает, где её `[[ссылка]]`; MSRV 1.71 | `comrak` 0.57 (BSD-2-Clause) — MSRV 1.89 выше нашей 1.85; `markdown` 1.0 (MIT) — последний выпуск 2025-04, без вики-ссылок |
| YAML (свойства) | `saphyr` 0.2.2 | MIT OR Apache-2.0 | Полный YAML 1.2, MSRV 1.85, выпуск 2026-10 | `serde_yaml` — помечен автором `+deprecated`; `serde_yml` — RUSTSEC-2025-0068 (unsound, unmaintained); `serde-saphyr` 2.0 — MSRV 1.89; `yaml-rust2` — тот же проект, что `saphyr`, в режиме поддержки |
| LZString (`.excalidraw.md`) | `lz-str` 0.2.1 | MIT OR Apache-2.0 | Порт `lz-string` с `compressToBase64` / `decompressFromBase64` — формат плагина Obsidian Excalidraw ([R2](../research/R2-obsidian-format.md)); последний выпуск 2022-10 — алгоритм заморожен, 285 тыс. загрузок за 90 дней | `lz-string` 0.1.1 — выпуск 2019, без репозитория |
| JSON Canvas | Свои типы на `serde` | — | Спецификация JSON Canvas 1.0 — несколько типов; свои типы держат порядок и незнакомые поля при экспорте | `jsoncanvas` 0.1.6 (MIT) — около 100 загрузок за 90 дней, один автор |

Источники: [API crates.io](https://crates.io/api/v1/crates/pulldown-cmark) (версии, лицензии, MSRV, загрузки — 2026-10-23), [документация `Options` pulldown-cmark 0.13.5](https://docs.rs/pulldown-cmark/0.13.5/pulldown_cmark/struct.Options.html), [RustSec: serde_yml](https://rustsec.org/packages/serde_yml.html).

Все зависимости дерева `strata-markdown` — MIT, Apache-2.0, BSD-3-Clause, Zlib, Unlicense OR MIT и Unicode-3.0 у `unicode-ident`, который уже есть в дереве через `serde_derive`: белый список [15](../15-architecture.md) §8.4 соблюдён.

## Проверка

`strata-markdown::scan` на выбранных крейтах — 6 тестов: `[[цель#заголовок|псевдоним]]`, `#^блок`, `![[embed]]`, кириллица; смещения ссылок в тексте; код и инлайн-код без ссылок и тегов; теги по правилам Obsidian (`#123` — не тег, `#2024-plan` — тег); свойства frontmatter со списками и тегами; сломанный frontmatter остаётся текстом, ссылки читаются; callout, сноска, формула и таблица ссылки не прячут.

Совместимость `lz-str` с `lz-string` 1.5.0 проверит импорт трёх реальных `.excalidraw.md` — часть 2 спайка 5 ([S5](S5-board.md)).

## Открытые вопросы

Новых нет.
