# Strata — правила работы в репозитории

## Состояние проекта

Реализация, этап 0 дорожной карты (`docs/16-roadmap.md` §3): каркас репозитория и спайки. Весь код пишет Claude (✅ R2), владелец проверяет сборки вех на macOS и Windows. Документация — в `docs/`, начинать с `docs/README.md`.

## Код

Структура — по `docs/15-architecture.md` §2. Модули добавляются тогда, когда до них доходит дорожная карта, а не заранее.

| Путь | Что |
|---|---|
| `crates/strata-model` | Типы домена без IO: ID (UUIDv7, Crockford base32), детерминированные ключи, виды нод, источники наборов изменений |
| `crates/strata-core` | Ядро (веха 1A): `workspace.rs` — документы Loro по 10 §2, операции 10 §4 с проверкой 05 §14, наборы изменений «до/после» и отмена 05 §11, выписка сети и корзина; `sqlite.rs` — `store.sqlite` и папка пространства (10 §3); `api.rs` — все вызовы как JSON для Tauri (`core`) и сборки для браузера; `home.rs` — пространства устройства для главной и локальный профиль (✅ Q-16-12, Q-16-14), команда Tauri `home`; `archive.rs` — `.strata.zip` (10 §3.5), один формат для папки и браузера; документы содержимого `content/<id>` и нити из `[[ссылок]]` заметки строит ядро |
| `crates/strata-core-wasm` | Ядро в браузере (WASM, хранилище в памяти, байты — в IndexedDB): e2e и `pnpm dev`; на macOS сборке нужен `AR_wasm32_unknown_unknown` = `llvm-ar` из `rustup component add llvm-tools` (системный `ar` не пакует wasm-объекты `psm`) |
| `crates/strata-cli` | Бинарник `strata` |
| `crates/strata-desktop` | Десктоп на Tauri 2 (ADR-0004); не входит в `default-members`, нужен WebView |
| `crates/strata-layout` | Раскладки без IO: физика звёздной карты — Барнс — Хат по группам с SIMD (`force3d.rs`, ADR-0005); `L` на сети (`net.rs`: слоистая `layered.rs`, радиальная `radial.rs`, силовая `force2d.rs`, спайк 10); замер — `cargo run --release -p strata-layout --example layout2d_speed` |
| `crates/strata-markdown` | Чтение Markdown без правки текста: `[[ссылки]]`, embed, теги, свойства frontmatter (`pulldown-cmark`, `saphyr`, спайк 11) |
| `crates/strata-layout-wasm` | Обёртка wasm-bindgen над `strata-layout`; свои lints (без `forbid(unsafe_code)` — его нарушают экспорты wasm-bindgen) |
| `packages/ui` | SPA на React 19 + Vite, общая для десктопа и веба; стартует с главной: `Shell.tsx` — шапка-вкладки как в ретро-браузере (логотип → главная, значки импорта и экспорта, вкладки открытых пространств, «+»), `src/home` — главная на весь экран (✅ Q-16-12), `src/workspace` — пространство на холсте поверх ядра (`CoreSync`, заметки и доски в документах ядра, `Enter` / `U`, корзина; один холст на все вкладки; хук e2e `window.__strataWs`), `Inspector.tsx` — панель свойств (поля 05 §6.1, люди, описание на Markdown, зависимости, подзадачи), `Layers.tsx` — «Слои» как в Figma: все ноды деревом во всю высоту слева, корзина внизу; панель свойств — во всю высоту справа; отмена и повтор — в шапке, картинки медиа в кругах и перетаскивание файлов на холст, `ContextMenu.tsx` — меню по ПКМ, `icons/Icon.tsx` — значки SerenityOS в духе Windows 98 (Хром и тело ноды через `view.setKindIcons`, 07 §6.1), «О программе» — `?about`; Хром без поясняющих строк: подсказки — в `title`; `src/proto` — Хром прототипа холста (`?proto`; `&net=dag`, `tree`, `mesh` — синтетические сети для `L`), `map3d.ts` — звёздная карта по `M`, `layouter.ts` — `L` в воркере, окна заметки и доски, `notes.ts` — их содержимое в `localStorage`; окна «Шрифты и окна» (`?fonts`), «Гравюра» (`?engraving`), «Благодарности» (`?credits`); `src/fonts` — шрифты OFL в сборке; `tests` — Node-тесты (cmap шрифтов) |
| `packages/backend` | `graph.ts` — граф сети в памяти, рабочая копия холста (правила `05 §8`, наборы изменений, отмена); `core.ts` — вызовы ядра (`Core`, `HomeBackend`); `sync.ts` — холст и ядро в ногу (15 §3.3); `browser.ts` (вход `@strata/backend/browser`) — WASM-ядро и пространства в IndexedDB; `pkg/` собирает `pnpm wasm` |
| `packages/canvas` | Холст на Pixi вне React: сцена, нити-шейдер, хит-тест на rbush, камера, машина жестов (`06 §5–6`); `decor.ts` + `rings.ts` — экранный слой бабла (кольца одним инстансным шейдером, значки, подписи), `looks.ts` — правила вида (`07 §4.5–4.9`), `icons.ts` — атлас game-icons (`scripts/game-icons.*`) и пиксельные значки нод (`createPixelIcons`), `backdrop.ts` / `background.ts` — фоны и контраст (`07 §7`, `§2.2`), `stylize.ts` — «привести к стилю» (`07 §6.5`) |
| `packages/view3d` | Звёздная карта (без React): 3D-выписка (`08 §8.3`), начальная раскладка (`08 §3.3`), `relax.ts` — модель сил и полная раскладка в WASM, `starmap.ts` — рендер three.js (`08 §4.1`, `§8.2`: звёзды, нити, туман, bloom ½), `bridge.ts` — «камера-мост» (`08 §7`, спайк 3), `graph-extract.ts` — выписка из графа прототипа; вход `@strata/view3d/map` — без спайковых кандидатов физики (`physics.ts`, замер — `STRATA_BENCH=1 … vitest run physics.bench --silent=false`) |
| `packages/layout` | `strata-layout` как WASM: `pkg/` собирает `pnpm wasm` (wasm-pack, не коммитится), загрузчик, воркер физики (`worker.ts`) и воркер `L` (`net-worker.ts`) |
| `packages/board` | Доска (ADR-0006, спайк 5): холст Excalidraw `next` с `ui={false}` (Excalidraw импортирует только этот пакет, холст грузится лениво); `binding.ts` — элементы и файлы в Loro и правило слияния Excalidraw; `assets.ts` — шрифты из сборки без CDN; `synth.ts` — B-2k для бенчмарка |
| `packages/editor` | Редактор заметок (ADR-0007, спайк 6): CodeMirror 6, live preview, OFM на Lezer, `loro-codemirror`, исходник ↔ `LoroText` с `meta` (BOM, переводы строк), корпус V-synth |
| `packages/design-tokens` | Токены «Тумана» (`07 §2.2`) → CSS-переменные и числа для сцены; пиксельная единица и шкала пиксельных кеглей (`07 §2.3–2.4`); свои 1-битные значки (`07 §6.2`) |
| `packages/i18n` | Строки RU + EN (✅ R2) |
| `packages/bench` | Харнесс бенчмарка шага 0.3: сценарии холста (Pixi), звёздной карты (`map-orbit-20k`, `docs/spikes/S2-starmap.md`), моста, заметки, доски (`board-b2k`) и Loro в WebView, формат отчёта (`docs/spikes/S1-canvas.md`); `?bench&only=<id>` — один сценарий |

Команды:

```sh
cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo test   # Rust (без десктопа)
cargo clippy -p strata-desktop -- -D warnings && cargo test -p strata-desktop  # десктоп (нужен WebKitGTK на Linux и собранный UI)
pnpm install && pnpm wasm && pnpm lint && pnpm typecheck && pnpm test        # TypeScript (pnpm wasm — до typecheck: типы WASM)
pnpm dev                                                                     # UI в браузере, http://localhost:5173
pnpm desktop:dev / pnpm desktop:build                                        # десктоп
```

Правила:
- Код и идентификаторы — на английском; комментарии — на английском, со ссылками на разделы документов (`05 §4.1`, `ADR-0003`).
- Каждое правило модели из `docs/05-domain-model.md` в коде покрыто тестом.
- Видимые строки интерфейса — только через `@strata/i18n`, в обоих каталогах.
- Хром — на токенах и в пиксельных единицах: рамки, фаски, отступы — `calc(k * var(--u))`, пиксельные кегли — `--st-font-*-size`, ширина окон — в `ch` шрифта интерфейса. Приложение рисует первый кадр после загрузки шрифтов.
- Хром не меняет размеры при смене языка и масштаба: фиксированная ширина окон, колонка подписей под самый длинный язык, однострочные значения с многоточием и подсказкой. Каждое новое окно или панель получает тест в `packages/ui/e2e` (RU и EN, DPR 1 и 2, Chromium и WebKit); тест сверяет рамки до и после смены языка и ищет обрезанный текст. Локально: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @strata/ui e2e --project=chromium`.
- Горячий путь холста и 3D — вне React (`docs/15-architecture.md` §4). На Сцене никаких `Graphics`, перестраиваемых для каждой ноды в каждом кадре: кольца — `RingLayer`, значки и плашки — пулы спрайтов. Полноэкранные слои дороги в программном WebGL CI: жесты в e2e идут на `?proto&plain` (без фона), раскладка — на полной Сцене.
- Ассеты — только с источником и лицензией: шрифты OFL лежат с текстом лицензии, game-icons перегенерируются скриптом из клона `game-icons/icons` (авторы — по папкам), значки SerenityOS (BSD 2-Clause) лежат в `packages/ui/src/icons/serenity` с `LICENSE` и `README.md` (коммит источника), «Благодарности» показывают всё, что поставляется.
- CSP десктопа (`tauri.conf.json`) отдаёт и `vite preview`, поэтому e2e ловят то, что заблокирует WebView: без `'unsafe-eval'`, WASM — через `'wasm-unsafe-eval'`. Для Pixi подключать `pixi.js/unsafe-eval`.
- WebKit округляет `performance.now()` до 1 мс: субмиллисекундные операции мерить сериями и делить на число операций.
- Сцена Pixi: мир и слои — render group, камера — их трансформация; `Culler` из Pixi не использовать (`docs/15-architecture.md` §4.1, п. 6–6а).
- Шейдеры (GLSL ES 3.0 через ANGLE): не называть uniform-переменные как служебные у Pixi (`uColor`, `uRound`, `uResolution`, `uWorldColorAlpha` и матрицы), не использовать зарезервированные слова (`half` и т. п.) и имена встроенных функций, не объявлять одну uniform-переменную в обоих шейдерах (разная точность — ошибка компоновки), комментарии только ASCII.
- Лицензия — AGPL-3.0-or-later (ADR-0009); зависимости — только совместимые (MIT, Apache-2.0, BSD, ISC, MPL-2.0; для ассетов — OFL, CC BY, CC0). GPL-2.0-only не берём.
- CI (`.github/workflows/ci.yml`) должен быть зелёным: fmt, clippy `-D warnings`, тесты, Biome, typecheck; десктоп собирается под macOS, Windows и Linux без подписи.
- Процессы в shell не убивать через `pkill -f <шаблон>`: шаблон совпадает с командной строкой самой оболочки.

## Документация

- Язык документов — русский. Названия продуктов, API, горячие клавиши и код — в оригинале.
- Термины — строго по `docs/glossary.md`. Новый термин сначала добавляется в глоссарий.
- Ядро — `docs/05-domain-model.md`. Остальные документы не противоречат ему; если противоречие нужно, сначала меняется модель данных и пишется ADR.
- Метки: ✅ решено ответом владельца (например, «✅ C3», «✅ R2»), ☑ принято по делегированию владельца, 💡 предложение, ❓ вопрос с ID `Q-<номер документа>-<номер>`.
- Каждый документ заканчивается разделом «Открытые вопросы». Все вопросы дублируются в `docs/17-open-questions.md`.
- Значимые технические решения оформляются как ADR в `docs/adr/` по шаблону из `docs/adr/README.md`.
- Фактические утверждения о библиотеках, лицензиях и версиях ссылаются на исследования в `docs/research/` или на первоисточник.
- Стиль: коротко, по делу, таблицы и списки вместо длинных абзацев, без канцелярита и рекламных оборотов.
- Типографика: «ёлочки», длинное тире с пробелами, `ё` где нужно.
