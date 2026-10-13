# R5. Движок досок: Excalidraw, tldraw и альтернативы для нод вида «доска»

> Дата исследования: 2026-10-13. Версии и даты сняты из npm registry в этот день. Исходники прочитаны в репозиториях: `excalidraw/excalidraw` `541653c` (2026-10-12), `tldraw/tldraw` `dd9b571` (2026-10-13), `zsviczian/obsidian-excalidraw-plugin` `b022db6` (2026-10-13), `excalidraw/excalidraw-room` `03ff435` (2023-12-15), `RahulBadenkal/y-excalidraw` `bfd9447` (2024-12-10), `loro-dev/loro-excalidraw` (2024-10-29), `toeverything/blocksuite` `5cb5cb6` (2025-07-07). Типы публичного API сверены по npm-архивам `@excalidraw/excalidraw@0.18.1`, `@excalidraw/excalidraw@0.18.0-43a92e6` (тег `next`) и `@zsviczian/excalidraw@0.18.143`.
>
> **Ограничение доступа.** Сайты tldraw.dev, plus.excalidraw.com и alternativeto.net из среды исследования не открывались. Условия лицензии tldraw прочитаны в исходниках страниц сайта в репозитории (`apps/docs/content/…`), ссылки даны на опубликованные страницы. Цифры в разделе 9 — **собственный синтетический замер** (Node 22.22.0, `loro-crdt` 1.16.4, `yjs` 13.6.33, один прогон). Это ориентир, а не бенчмарк для публикации. Всё, что проверить не удалось, помечено «не проверено».
>
> Связанные исследования: [R2](R2-obsidian-format.md) — формат `.excalidraw.md`, [R3](R3-crdt-sync.md) — Loro и схема документов, [R4](R4-app-shell-rendering.md) — React 19, PixiJS, Tauri.

## Кратко

- **Рекомендация: Excalidraw (MIT) — движок досок в MVP.** Встраиваем его за тонким адаптером `BoardEngine`, сцену храним в Loro-документе содержимого ноды, картинки — в хранилище ассетов Strata по SHA-256. Виджеты «короткая заметка» и «to-do» — свои React-компоненты внутри элементов `embeddable` (через `renderEmbeddable`). Их текст и пункты живут в `LoroText` и `LoroMovableList` и сливаются посимвольно, а не «последний победил».
- **Стабильная ветка Excalidraw заморожена.** 0.18.0 вышел 2025-03-11, 0.18.1 (2026-04-20) — только патч безопасности Mermaid. Всё новое есть лишь в снапшотах `next` (`0.18.0-43a92e6` от 2026-10-12, 45 снапшотов за 2026 год), и там уже переименованы методы API. Нужное Strata: свой UI вместо встроенного (`ui={false}`), поток дельт `onIncrement`, стикеры `stickynote`, `imageOptions`, управляемый `activeTool`. Вывод: закрепляем точный снапшот `next` и прячем API за адаптер.
- **Свои React-виджеты внутри сцены возможны штатно.** Элемент `embeddable` ведёт себя как прямоугольник сцены: выделение, перенос, фреймы, привязка стрелок. `renderEmbeddable` подставляет вместо `<iframe>` любой JSX, `validateEmbeddable` пропускает свою схему `strata://widget/…`. Ограничения: DOM-слой всегда лежит поверх рисунка, первый клик только «активирует» виджет, в PNG/SVG-экспорт он не попадает.
- **Своих типов элементов в Excalidraw нет.** Набор типов закрыт, неизвестные типы `restore()` молча выбрасывает. Зато есть свои инструменты (`{type: "custom", customType}` + `onPointerDown/Up`) и поле `customData` на любом элементе. Своих шрифтов в публичном API нет: номера семейств зашиты. `registerLocalFont` есть только в форке `@zsviczian/excalidraw` (MIT), на котором живёт плагин Obsidian. Пиксельный стиль: UI доски можно сделать полностью своим, холст — только частично.
- **tldraw расширяется лучше всех, но юридически не подходит.** У него кастомные фигуры и инструменты, `TLAssetStore`, темы в v5. Однако с 4.0 (2025-09-18) продакшн требует ключ лицензии. Документация tldraw прямо пишет об open source: «you and your downstream users will require their own trial, commercial, or hobby license». Хобби-лицензия выдаётся по усмотрению, только для некоммерческих проектов, с водяным знаком и телеметрией, ключ привязан к доменам. Для self-hosted Strata это неприемлемо.
- **Готового CRDT-биндинга Excalidraw нет, но он и не сложен.** Excalidraw сам сливает правки как LWW по элементу (`version`, `versionNonce`, дробный `index`). Биндинг к Loro: `elements: LoroMap<id, JSON элемента>`, запись по окончании жеста, промежуточные кадры — через эфемерный канал. Удалённые правки применяются штатным `reconcileElements` и `updateScene({captureUpdate: NEVER})`. Наш замер на 1000 элементов: снапшот 290 КБ, перетаскивание 20 элементов — обновление 5,3 КБ, открытие доски — около 0,1 с.
- **Остальные варианты как движок не подходят.** BlockSuite (MPL-2.0, отдельный репозиторий стоит с 2025-07, завязан на Yjs и модель блоков AFFiNE). Penpot (MPL-2.0, целая платформа). draw.io (Apache-2.0, PR не принимает, совместного редактирования нет). Konva и Fabric (MIT) — только движки рисования. Свой редактор на PixiJS — путь для этапа 2+, если упрёмся в стиль или производительность. Формат данных и тогда оставляем совместимым с Excalidraw.
- **Совместимость с Obsidian почти бесплатна.** `.excalidraw.md` плагина Excalidraw содержит ту же JSON-сцену (R2): импорт досок — прямой перенос, экспорт обратно тоже возможен. Виджеты экспортируются как `embeddable` со ссылкой `[[заметка]]`, плагин сам рисует такие заметки.

## Находки

### 1. Excalidraw: версии, лицензия, темп релизов

| Пакет | Версия | Дата | Лицензия | Источник |
|---|---|---|---|---|
| `@excalidraw/excalidraw` (`latest`) | 0.18.1 | 2026-04-20 | MIT | [npm](https://www.npmjs.com/package/@excalidraw/excalidraw), [LICENSE](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) |
| `@excalidraw/excalidraw` (`next`) | 0.18.0-43a92e6 | 2026-10-12 | MIT | npm, тег `next` |
| `@zsviczian/excalidraw` (форк для плагина Obsidian) | 0.18.143 | 2026-10-12 | MIT | [npm](https://www.npmjs.com/package/@zsviczian/excalidraw) |
| `@excalidraw/mermaid-to-excalidraw` | 2.2.2 | 2026-03-24 | MIT | [npm](https://www.npmjs.com/package/@excalidraw/mermaid-to-excalidraw) |
| `y-excalidraw` | 2.0.12 | 2024-12-10 | MIT | [GitHub](https://github.com/RahulBadenkal/y-excalidraw) |
| `excalidraw-room` (сервер-ретранслятор) | без релизов, последний коммит 2023-12-15 | — | MIT | [GitHub](https://github.com/excalidraw/excalidraw-room) |

- **0.18.0 (2025-03-11)** — последний функциональный релиз. В нём появились палитра команд, «многопользовательский» undo/redo, редактируемая статистика элементов, перенос текста, выбор шрифтов, шрифт для CJK, ломаные стрелки, flowchart, поиск по сцене, обрезка картинок и ссылки на элементы. Пакет стал только ESM, UMD-сборка удалена ([CHANGELOG](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md)).
- **0.18.1** — патч безопасности: Mermaid XSS CVE-2025-54881, обновление `mermaid-to-excalidraw` до 2.2.2 ([релизы](https://github.com/excalidraw/excalidraw/releases)). О 0.19 на 2026-10-13 нигде нет ни слова.
- **Ветка `master` живёт активно,** раздел «Unreleased» в CHANGELOG огромный. Снапшоты `master` публикуются в npm как `0.18.0-<hash>`, последний из них — под тегом `next`. За 2026 год опубликовано 45 таких снапшотов (плюс 0.18.1), всего у пакета 482 версии.
- **Peer-зависимости:** `react` и `react-dom` `^17.0.2 || ^18.2.0 || ^19.0.0` (оба пакета). С выбором React 19 в R4 совместимо.
- **Размер:** JS в `dist/prod` версии 0.18.1 весит около 2,7 МБ, после gzip — около 1,0 МБ. Шрифты и локали грузятся лениво (наш подсчёт по npm-архиву).
- **Шрифты по умолчанию тянутся с CDN `esm.sh`**, если не задан `window.EXCALIDRAW_ASSET_PATH` ([ExcalidrawFontFace.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/ExcalidrawFontFace.ts)). Для local-first-десктопа и офлайна шрифты нужно класть в сборку и задавать путь явно.

### 2. API встраивания: 0.18.1 против `next`

Сверено по `dist/types` обоих npm-архивов и по [types.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/types.ts) в `master`.

| Возможность | 0.18.1 | `next` (2026-10) | Зачем Strata |
|---|---|---|---|
| `initialData` (`elements`, `appState`, `files`, `libraryItems`) | ✅ | ✅ | Открытие доски из Loro |
| `onChange(elements, appState, files)` | ✅ | ✅ | Запасной путь биндинга: дифф по `version` |
| `onIncrement` (дельты: `DurableIncrement` / `EphemeralIncrement`) | ❌ | ✅ | Биндинг без диффа всей сцены. «Durable» — запись в CRDT, «ephemeral» (перетаскивание, ресайз) — эфемерный канал ([store.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/store.ts)) |
| `updateScene({elements, appState, collaborators, captureUpdate})` | ✅ | ✅ | Применение удалённых правок с `CaptureUpdateAction.NEVER` |
| `applyDeltas`, `mutateElement` в API | ❌ | ✅ | Точечные правки без пересборки массива |
| `excalidrawAPI` → `onExcalidrawAPI`, плюс `onMount`, `onInitialize`, `onUnmount` | старое имя | переименовано | Ломающее изменение: адаптер обязателен |
| `scrollToContent` → `setViewport` | старое | заменено | То же |
| `ui={false}` (не рисовать встроенный UI) | ❌ | ✅ | Свой ретро-тулбар и панели Strata |
| `interaction` (инертный режим с исключениями) | ❌ | ✅ | Превью доски, режим «только чтение» |
| `activeTool` (инструмент под управлением хоста) | ❌ | ✅ | Тулбар Strata управляет инструментом |
| `setActiveTool({type: "custom", customType})` | ✅ | ✅ | Свои инструменты: «виджет to-do», «карточка ноды» |
| `imageOptions` (`maxWidthOrHeight`, `maxFileSizeBytes`) | ❌ (жёстко 1440 px и 4 МБ) | ✅ | Референсы в большем разрешении |
| `generateIdForFile(file)` | ✅ | ✅ | `fileId` = SHA-256 оригинала, ключ хранилища ассетов |
| `addFiles`, `getFiles` | ✅ | ✅ | Ленивая подгрузка картинок. Метода удаления файлов нет |
| `validateEmbeddable`, `renderEmbeddable` | ✅ | ✅ | Виджеты Strata |
| `onLinkOpen`, `generateLinkForSelection` | ✅ | ✅ | Ссылки `strata://node/…` и глубокие ссылки на элементы |
| `onPaste`, `onDuplicate` (в `next` — с вето и заменой) | ✅ | ✅ | Перехват вставки картинок, Alt-drag |
| `selection.select/add/remove/clear` | ❌ | ✅ (2026-10-10) | Выделение из поиска и от AI |
| `onExport` (асинхронный, с прогрессом) | ❌ | ✅ | Дождаться оригиналов картинок перед экспортом |
| `theme`, `onThemeChange` | `theme` | оба | — |
| `isCollaborating`, `onPointerUpdate`, `collaborators` | ✅ | ✅ | Курсоры и выделения участников |
| Элемент `stickynote` (клавиша `N`) | ❌ | ✅ (2026-09-06) | Нативные стикеры: заметка с автоподбором шрифта и датой создания |

Источник фактов про `next`: раздел «Unreleased» в [CHANGELOG](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md).

### 3. Встраиваемые элементы: можно ли рисовать свои React-виджеты в сцене

Как это устроено, по [App.tsx](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/App.tsx) (`renderEmbeddables`) и [embeddable.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/embeddable.ts):

- **Два типа.** `embeddable` — элемент со ссылкой `link`, которую проверяет `validateEmbeddable` (по умолчанию — белый список популярных хостов). `iframe` — сгенерированный HTML (magic frame).
- **Свой валидатор.** Функция `(link) => boolean | undefined`: `true` разрешает ссылку, `undefined` отдаёт решение встроенному валидатору. Для своей схемы хватает `link.startsWith("strata://widget/") ? true : undefined` ([props.mdx](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/props/props.mdx)).
- **Рендер.** Для каждого прошедшего проверку элемента Excalidraw создаёт `div.excalidraw__embeddable-container` с `position: absolute; z-index: 2` поверх статического и интерактивного canvas. Позиция задаётся `translate(...) scale(zoom)`, поворот — `rotate(angle)`. Внутрь кладётся `props.renderEmbeddable?.(el, appState)`, а если хост вернул `null` — `<iframe sandbox>` ([render-props.mdx](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/props/render-props.mdx)).
- **Свои React-компоненты работают полноценно.** Внутри обычный DOM: поля ввода, чекбоксы, IME для кириллицы, CSS. Прецедент — плагин Obsidian Excalidraw: через `renderEmbeddable` он рисует Markdown-заметки по ссылкам `[[…]]` в своём `CustomEmbeddable` ([ViewExcalidrawExtensionRenderer.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/view/managers/ViewExcalidrawExtensionRenderer.ts)).
- **Клавиатура внутри виджета.** Обработчик клавиш Excalidraw выходит сразу, если цель события — «записываемый» элемент (`isWritableElement`): `<textarea>`, `<input>` текстового типа или любой узел внутри `.cm-editor`, то есть CodeMirror 6 распознан явно ([utils.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/utils.ts), `onKeyDown` в App.tsx). Буквы в поле виджета не переключат инструмент. Голый `contenteditable` в этот список не входит, его не используем. `Ctrl+V` Excalidraw обрабатывает **до** этой проверки, поэтому вставку внутри виджета нужно проверить в спайке.
- **Что даёт сцена «бесплатно».** Виджет — прямоугольный элемент сцены. Он выделяется, двигается, масштабируется, входит в фреймы и группы, копируется и дублируется (Alt-drag), к нему привязываются стрелки. На нём есть `customData` для своих полей.

Ограничения (по коду, в UI не проверено):

| Ограничение | Следствие для Strata |
|---|---|
| DOM-слой лежит поверх обоих canvas (`z-index: 2`) | Стрелку или картинку нельзя положить поверх виджета, порядок слоёв для виджетов не работает |
| Указатель доходит до содержимого только у «активного» виджета (`activeEmbeddable.state === "active"`). При наведении показывается подсказка «нажмите, чтобы взаимодействовать» | Отметить пункт to-do — два клика: активировать и нажать. Можно смягчить своим UX, но без форка не убрать (не проверено) |
| Виджет, хоть раз попавший во вьюпорт, остаётся смонтированным (`initializedEmbeds`), вне экрана он только скрыт через `display: none` | Сотни виджетов — сотни живых React-деревьев. Рисовать тяжёлое содержимое (CM6) только при редактировании |
| В экспорт не попадает: PNG по умолчанию без embeds, в SVG вместо виджета ссылка `<a>` ([staticSvgScene.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/staticSvgScene.ts)) | Перед экспортом и для миниатюр конвертировать виджеты в текст и прямоугольники через skeleton API |
| Масштаб через CSS `scale(zoom)` | Пиксельные шрифты при дробном зуме мылятся |

### 4. Фреймы, библиотеки, ссылки, skeleton API

- **Фреймы** (`frame`, `magicframe`): у детей проставляется `frameId`, есть обрезка содержимого по фрейму и имя фрейма. Экспорт отдельного фрейма — опция `exportingFrame` ([export.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/utils/src/export.ts)). Для досок референсов фреймы — это «разделы» в духе Miro.
- **Библиотеки:** `.excalidrawlib` (JSON), `libraryItems` в `initialData`, `updateLibrary`, `onLibraryChange`. Публичный каталог [excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries) — MIT. Strata может поставлять свою библиотеку «гравюрных» штампов и рамок в стиле дизайна.
- **Ссылки на элементы:** `generateLinkForSelection(id, type)` и `onLinkOpen` позволяют ссылаться из заметки на конкретную область доски (`strata://node/<board>#<elementId>`) и открывать ноды по клику на элемент со ссылкой `strata://node/<id>`.
- **Skeleton API** `convertToExcalidrawElements` создаёт полноценные элементы из минимального описания: фигуры, текст, стрелки с привязками, контейнеры с текстом, фреймы, а в `next` ещё и стикеры ([excalidraw-element-skeleton.mdx](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton.mdx)). Пригодится для экспорта виджетов, импорта и операций AI на клиенте. Для измерения текста API нужен DOM, без DOM — `setCustomTextMetricsProvider` (экспортирован и в 0.18.1).
- **Mermaid → сцена:** `@excalidraw/mermaid-to-excalidraw` 2.2.2 (MIT). Готовый путь «AI пишет Mermaid → схема на доске».

### 5. Свои инструменты и элементы: плагин или форк

| Что хотим | Штатно | Через форк |
|---|---|---|
| Свой инструмент (клик или протяжка ставит виджет, карточку ноды, штамп) | ✅ `ActiveTool {type: "custom", customType}`, события `onPointerDown/Up`, вставка через `updateScene`. В `next` — `activeTool` под управлением хоста и `interaction.enabled.tools.custom` | — |
| Свои данные на элементе | ✅ `customData?: Record<string, any>` на любом элементе, сохраняется при `restore` ([props.mdx](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/props/props.mdx)) | — |
| Свой тип элемента со своей отрисовкой на canvas | ❌ Объединение `ExcalidrawElement` закрыто ([types.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/types.ts)). Неподдерживаемые типы `restoreElement` возвращает как `null`, и они выпадают из сцены ([restore.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/restore.ts)) | Нужен форк |
| Свой шрифт на холсте | ❌ `FONT_FAMILY` — фиксированный словарь номеров 1–10. В коде прямо сказано: «likely we will need to abandon number value in order to support custom fonts» ([Fonts.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/Fonts.ts)) | Форк. Прецедент: `registerLocalFont(fontMetrics, uri)` в `@zsviczian/excalidraw`, слот 4 «Local Font» ([FontManager.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/core/managers/FontManager.ts)) |
| Удаление файлов из памяти, виртуализация картинок | ❌ Есть только `addFiles` | Форк |

**Цена форка.** У форка `@zsviczian/excalidraw` 435 версий, и он идёт вплотную за `master`: в 0.18.143 уже есть `stickynote`, `onIncrement`, `ui` и `registerLocalFont` (проверено по типам в npm-архиве). Это работа отдельного мейнтейнера. Strata стоит начинать без форка, а точечные патчи (шрифт, `removeFiles`) держать в `patch-package` или мягком форке. Переходить на полный форк — только если патчей станет много.

### 6. Темизация, шрифты, ретро-стиль

- **Темы:** только `light` и `dark`. В тёмной теме Excalidraw перекрашивает **каждый цвет элемента** функцией `applyDarkModeFilter`: инверсия 93% и поворот тона на 180°, как CSS-фильтр ([colors.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/colors.ts), [renderElement.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/renderElement.ts)). Белая линия в тёмной теме не останется белой.
- **Фон холста** `viewBackgroundColor` может быть `"transparent"`: статический canvas тогда очищается, а не заливается ([helpers.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/helpers.ts)). Доску можно положить поверх туманного фона Strata.
- **UI-хром:** в `theme.scss` около 200 CSS-переменных (цвета, `--ui-font` и т. д.) ([theme.scss](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/css/theme.scss)). В `next` есть `ui={false}`: встроенный тулбар, меню, панели, контекстное меню и попапы не рисуются, а хост делает свой UI через API. Это главный рычаг для ретро-окон Strata. В 0.18.1 остаются только CSS-переопределения, `UIOptions` и рендер-пропсы.
- **Стиль элементов по умолчанию** задаётся через `appState.currentItem*` (`currentItemRoughness`, `currentItemFontFamily`, `currentItemStrokeColor` и т. д.). Палитра «быстрых» цветов — `appState.colorTopPicks` (в `next`). `roughness: 0` убирает «рисованность» rough.js.
- **Шрифты в комплекте:** Excalifont (рукописный), Nunito, Lilita One, Comic Shanns, Liberation Sans, Cascadia, Virgil (устаревший), а также фолбэки Xiaolai (CJK) и эмодзи. Кириллица есть у Excalifont (подмножество `U+400-45f,U+490-491,U+2116`) и Nunito, у Lilita One её нет (по `unicodeRange` в `fonts/*/index.ts`). Excalifont распространяется под SIL OFL 1.1.
- **Итог для «Мора» и ретро.**
  - Окна, тулбар и панели доски — полностью свои (DOM, пиксельные шрифты, R7).
  - Холст — нейтральный: прозрачный фон поверх тумана, `roughness: 0`, палитра Strata, Nunito или Excalifont. Тему лучше держать `light`, иначе цвета инвертируются. Точный выбор — в спайке.
  - Пиксельный шрифт **на холсте** — только через форк.
  - Виджеты Strata — полностью в своём стиле.
- **Горячие клавиши.** Инструменты Excalidraw: `V` `R` `D` `O` `A` `L` `P/X` `T` `N` `E` `F` `K` `H` и цифры ([Tools.tsx](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/Tools.tsx)). `L` (линия) конфликтует с `L` Houdini (авто-раскладка). Навигационные клавиши Strata (`U` — наверх, `Tab`, путь) нужно перехватывать раньше Excalidraw: `handleKeyboardGlobally={false}` плюс свой обработчик в фазе capture. Alt-drag для дублирования совпадает с Houdini.

### 7. Картинки и файлы: как вынести их в хранилище Strata

- **Модель Excalidraw.** Элемент `image` хранит `fileId`, `status: "pending" | "saved" | "error"`, `scale` и `crop`. Сами байты лежат в `BinaryFiles`: `{id, mimeType, dataURL, created, lastRetrieved?, version?}` ([types.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/types.ts)). Байты не входят в сцену: элементы и файлы живут раздельно.
- **`dataURL` — просто `img.src`.** `loadHTMLImageElement` присваивает его в `image.src` ([image.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/image.ts)). Технически подойдёт и `blob:`-URL. Чужой домен без CORS «запачкает» canvas и сломает экспорт, поэтому надёжнее отдавать `blob:` или `data:` из локального кэша.
- **Идентификатор файла.** По умолчанию это SHA-1 содержимого **до** ресайза ([blob.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/blob.ts)). Через `generateIdForFile` можно вернуть SHA-256: тогда `fileId` совпадает с ключом ассета Strata. В этот же колбэк приходит **оригинальный** `File`, так что там же можно положить оригинал в хранилище.
- **Ресайз при вставке.** Excalidraw уменьшает картинку до `maxWidthOrHeight` и отвергает файлы больше `maxFileSizeBytes`. По умолчанию это 1440 px и 4 МБ ([constants.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts)). В 0.18.1 значения жёсткие, в `next` их задаёт `imageOptions`. Для досок референсов 1440 px мало: при приближении детали теряются.
- **Как это делает excalidraw.com.** `FileManager` грузит и сохраняет файлы отдельно от сцены, со статусами `loading/loaded/error` ([FileManager.ts](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/data/FileManager.ts)). Хранилище — Firebase Storage `/files/rooms`, лимит 4 МиБ, кэш на год ([app_constants.ts](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/app_constants.ts)). Strata повторяет ту же схему со своим хранилищем ассетов.
- **Память.** Все добавленные файлы держатся строками `dataURL` (base64, +33%) плюс декодированными `HTMLImageElement`. Метода выгрузки нет. Для сотен фото в полном разрешении это гигабайты. Поэтому в Excalidraw отдаём **рабочие копии** (WebP ≤ 2048–4096 px из кэша миниатюр), а файлы подгружаем лениво по видимой области (`onScrollChange`). Действенность ленивой подгрузки не проверена — пункт спайка.

### 8. Производительность больших досок

- **Отрисовка:** Canvas 2D, два слоя (статический и интерактивный). Отбрасываются элементы вне вьюпорта (`isElementInViewport` в [Renderer.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/scene/Renderer.ts)), формы кэшируются (`ShapeCache`). Есть отдельные оптимизации отрисовки картинок (#8697) и библиотеки (#9060, #9086) ([CHANGELOG](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md)).
- **Опубликованных замеров на тысячи элементов не нашлось.** В трекере висят жалобы на конкретные сценарии, например лаги ластика на большом холсте (по данным поиска, [issues](https://github.com/excalidraw/excalidraw/issues)). Узкие места по устройству: `freedraw` (сотни точек на штрих), большие картинки, сотни смонтированных embeds, `onChange` с полным массивом элементов на каждое изменение.
- **Для Strata это не критично.** Доска референсов — это сотни, максимум низкие тысячи элементов. «Тысячи нод без лагов» (требование к графу) относится к холсту сетей на PixiJS (R4), а не к доске. Порог для спайка: 2 000 элементов и 200 картинок, p95 кадра ≤ 16,7 мс при панорамировании.

### 9. Хранение сцены в CRDT: собственный замер

Синтетика по мотивам сцены Excalidraw: 40% прямоугольников и эллипсов, 25% текста, 20% стрелок, 10% картинок, 5% штрихов `freedraw` по 50–200 точек. Средний элемент в JSON занимает около 650 байт. «Жест» — сдвиг 20 элементов с ростом `version`, один коммит на жест, всего 200 жестов. Режимы: **value** — элемент лежит целиком значением в `LoroMap` (LWW на элемент), **nested** — каждый элемент как вложенная `LoroMap` (LWW на поле). Для сравнения — Yjs `Y.Map` со значениями-объектами.

| Вариант | Элементов | JSON | Снапшот после создания (gzip) | Обновление за жест (20 эл.) | Снапшот после 200 жестов | Shallow после 200 жестов | Открытие (import + toJSON) |
|---|---|---|---|---|---|---|---|
| Loro, value | 1 000 | 634 КБ | 290 КБ (245) | 5,3 КБ | 848 КБ | 146 КБ | 110 мс |
| Loro, nested | 1 000 | 634 КБ | 564 КБ (379) | 0,8 КБ | 668 КБ | 403 КБ | 75 мс |
| Yjs, value | 1 000 | 635 КБ | 561 КБ (104) | 9,2 КБ | 580 КБ (история не хранится, GC) | — | 108 мс |
| Loro, value | 5 000 | 3,1 МБ | 1,3 МБ (1,1) | 5,6 КБ | 1,9 МБ | 0,66 МБ | 361 мс |
| Loro, nested | 5 000 | 3,1 МБ | 2,8 МБ (1,7) | 0,8 КБ | 2,9 МБ | 2,0 МБ | 359 мс |
| Yjs, value | 5 000 | 3,1 МБ | 2,8 МБ (0,5) | 9,5 КБ | 2,8 МБ | — | 179 мс |

Выводы:
- **Режим value** совпадает с семантикой Excalidraw (LWW на элемент) и даёт самый компактный shallow-снапшот. Цена — около 260 байт трафика на сдвинутый элемент и рост истории на размер элемента при каждой правке. Для 10 человек это пренебрежимо мало, а историю сжимают shallow-снапшоты на сервере (R3).
- **Режим nested** экономит трафик в 6 раз, но вдвое раздувает снапшот. Главное — он рискует собрать невалидный элемент из полей разных авторов (например, `points` от одного и `width` от другого). Об этом предупреждает и автор `y-excalidraw` ([README](https://github.com/RahulBadenkal/y-excalidraw)).
- **Писать в CRDT каждое `pointermove` нельзя:** история вырастет на порядки. Пишем по окончании жеста, промежуточные кадры отправляем через эфемерный канал.

### 10. Совместная работа: как это делают excalidraw.com и биндинги

**excalidraw.com** ([Collab.tsx](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx), [Portal.tsx](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx), [reconcile.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts)):
- Клиент рассылает только элементы, у которых `version` выросла после последней отправки. Раз в 20 с отправляется вся сцена — на случай потерянных сообщений (`SYNC_FULL_SCENE_INTERVAL_MS = 20000`). Курсоры идут по «volatile»-каналу с частотой около 30 Гц (`CURSOR_SYNC_TIMEOUT = 33`).
- Полезная нагрузка шифруется AES-GCM ключом комнаты (`encryptData`) и уходит через socket.io.
- **Слияние** (`reconcileElements`): удалённый элемент отбрасывается, если локальный сейчас редактируется (текст, ресайз, создание), если у локального больше `version` или, при равных версиях, меньше или равен `versionNonce`. Затем элементы сортируются по дробному `index`, дубликаты индексов чинятся. Удаление — это флаг `isDeleted` (tombstone). Удалённые элементы хранятся сутки (`DELETED_ELEMENT_TIMEOUT`).
- Сохраняют сцену сами клиенты (в Firebase), тоже через reconcile.

**excalidraw-room** — 153 строки на socket.io 4 ([index.ts](https://github.com/excalidraw/excalidraw-room/blob/master/src/index.ts)). Сервер ничего не знает о сцене: комнаты, `server-broadcast` → `client-broadcast` с шифротекстом, отдельный `server-volatile-broadcast` и follow-режим. Последний коммит — 2023-12-15. Для Strata это образец протокола, но не компонент: нам нужен сервер с правами, хранением и MCP (R3, R4).

**Undo в мультиплеере.** С 0.18 история Excalidraw записывает только локальные изменения. Удалённые правки и инициализацию следует применять с `CaptureUpdateAction.NEVER`, тогда они никогда не попадут в локальный undo ([CHANGELOG 0.18.0](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md)). Значит, для сцены можно оставить встроенный undo Excalidraw и не перехватывать кнопки через DOM, как это делает `y-excalidraw`.

**Готовые CRDT-биндинги:**

| Биндинг | Движок | Состояние | Как устроен |
|---|---|---|---|
| [y-excalidraw](https://github.com/RahulBadenkal/y-excalidraw) 2.0.12 | Yjs | Последний коммит 2024-12-10, peer `@excalidraw/excalidraw ^0.17.6` (0.18 не поддержан) | `Y.Array<Y.Map>` с `{el, pos}`, ассеты в `Y.Map`, awareness. Синхронизация на уровне элемента. Undo — отдельный плагин, перехватывает кнопки через DOM |
| [loro-excalidraw](https://github.com/loro-dev/loro-excalidraw) | Loro 1.0.8-alpha.3 | «proof of concept… not optimized for production», 2024-10-29, Excalidraw ^0.17 | `LoroList` элементов, синхронизация через BroadcastChannel, машина времени через `checkout` |
| Свой биндинг Strata | Loro 1.16 (R3) | — | См. раздел «Рекомендация». Объём — около 300–500 строк (оценка R3, не проверено) |

Поиск в 2025–2026 годах новых биндингов Excalidraw к Yjs или Loro не нашёл.

### 11. Экспорт

- `exportToCanvas`, `exportToBlob` (PNG/JPEG/WebP), `exportToSvg`, `exportToClipboard`, `serializeAsJSON`, `serializeLibraryAsJSON`, `loadFromBlob`, `restore*` — всё есть в публичном API 0.18.1. Можно экспортировать фрейм (`exportingFrame`), задать отступы и `maxWidthOrHeight` ([export.mdx](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/utils/export.mdx)). В SVG-экспорт шрифты встраиваются подмножеством (0.18.0).
- **Экспорт требует DOM и canvas.** Миниатюру доски для превью в индексе (05-domain-model §13) надёжнее делать на клиенте при сохранении, с задержкой: `exportToBlob`, 512 px, виджеты заранее сконвертированы. Сервер на Rust без JS-рантайма отрисовать доску не сможет. Если доску изменил AI, а клиентов нет, превью устареет до следующего открытия.

### 12. Как хранит доски плагин Obsidian Excalidraw

Подробно — в [R2](R2-obsidian-format.md), §«Excalidraw». Коротко, по [excalidrawMarkdownParsing.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/excalidrawMarkdownParsing.ts) и [ExcalidrawData.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/ExcalidrawData.ts):
- Файл `*.excalidraw.md`, во frontmatter стоит `excalidraw-plugin: parsed`.
- Секции внутри `%% … %%`:
  - `# Excalidraw Data` / `## Text Elements` — тексты элементов с якорями `^elementId`, поэтому они ищутся и линкуются средствами Obsidian;
  - `## Element Links`;
  - `## Embedded Files` — `fileId: [[картинка.png]]` или URL, а также LaTeX;
  - `## Drawing` — сцена JSON в блоке ` ```compressed-json ` (LZString base64 строками по 256 символов) или ` ```json `, если сжатие выключено.
- Картинки — обычные файлы vault, сцена ссылается на них через `fileId`.
- Встроенные Markdown-заметки — элементы `embeddable` со ссылкой `[[…]]`. Плагин рисует их интерактивно (см. раздел 3).
- **Лицензия плагина — AGPL-3.0** (LICENSE в репозитории, бейдж на GitHub). Код копировать нельзя, если лицензия Strata несовместима. Формат пишем сами (R2).
- Плагин работает на форке `@zsviczian/excalidraw` 0.18.143 (MIT), который знает `stickynote`. Значит, стикеры из `next` переживут экспорт в Obsidian. Старый Excalidraw 0.18.1 их выбросит.

### 13. tldraw: лицензия, расширяемость, синхронизация

**Лицензия** ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md), [License](https://tldraw.dev/community/license), [License key](https://tldraw.dev/sdk-features/license-key); исходники страниц — в `apps/docs/content` репозитория):
- В npm у `tldraw` 5.5.2 (2026-10-02), `@tldraw/sync` и `@tldraw/sync-core` 5.5.2 стоит `"license": "SEE LICENSE IN LICENSE.md"`.
- По умолчанию разрешено только использование «in Development Environments». Production Environment определён по использованию: «where the software is used to provide functionality to end users», а не по имени хоста.
- Условия: «Not to use the Software in Production Environments», «Not to disable, change, or interfere with the Software's License Key enforcement», «Not to make the Software available under a license that supersedes or negates the effect of this License».
- **Типы лицензий** (страница License key от 2026-01-31):

| Тип | Водяной знак | Срок | Назначение | Телеметрия |
|---|---|---|---|---|
| Trial | нет | 100 дней, одна на компанию или проект | Оценка | ID лицензии, тип, версия SDK, URL страницы |
| Commercial | нет | годовая | Коммерческий продакшн | нет |
| Hobby | **да**, «made with tldraw» | «Varies» | Некоммерческие проекты, **выдаётся по усмотрению** («discretionary: we review each request») | ID лицензии, тип, версия SDK, URL страницы |

- **Цена коммерческой лицензии не опубликована.** Страница цен говорит о «value-based pricing» и скидках для новых компаний (по данным поиска, [pricing](https://tldraw.dev/pricing)). Цифра «от $6 000 в год» встречается только на стороннем обзорном сайте — не проверено.
- **Механика ключа.** Ключ проверяется на клиенте, без сети. В нём зашиты разрешённые домены, тип и срок. В продакшне (HTTPS, не loopback, `NODE_ENV=production`) без ключа SDK через 5 секунд **перестаёт рисовать редактор**. После истечения годового ключа есть 30 дней отсрочки.
- **Про open source tldraw пишет прямо:** «If you wish to include tldraw in an open source project, you may do so but the SDK itself must remain under its original license. This means that you and your downstream users will require their own trial, commercial, or hobby license in order to use the SDK in production.»
- **История:** ключ для продакшна введён в 4.0 (2025-09-18, [v4.0.0.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/releases/v4.0.0.mdx)). 5.0 (2026-05-06) принёс систему тем, `OverlayUtil`, кастомные типы записей и ассетов ([v5.0.0.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/releases/v5.0.0.mdx)). Есть CLA для контрибьюторов (`CLA.md`).

**Расширяемость — лучшая в классе:**
- Кастомная фигура — класс `ShapeUtil` с React-компонентом в `HTMLContainer` ([shapes.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/shapes.mdx)). To-do-виджет был бы полноценной фигурой со слоями и экспортом.
- Инструменты — `StateNode` ([tools.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/tools.mdx)).
- `TLAssetStore` с `upload` и `resolve`. `resolve` получает масштаб экрана и DPR и может отдать уменьшенную копию ([assets.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/assets.mdx)). Это ровно та ленивая подгрузка картинок, которой не хватает Excalidraw.
- **tldraw sync** — серверный протокол на WebSocket. Шаблоны: Cloudflare Durable Objects + R2 и простой сервер на Node ([sync.mdx](https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/sync.mdx)). Авторизация, лимиты и история — «features that we have not provided». Сервер только на JS, это вторая система синхронизации рядом с Loro.

**Вывод по tldraw для Strata — не годится.**
1. Каждый, кто разворачивает Strata у себя, обязан получить свой ключ. Хобби-ключ выдаётся по усмотрению, с водяным знаком и телеметрией. Командам на работе нужна коммерческая лицензия по закрытой цене.
2. Ключ привязан к доменам, а у self-hosted-серверов домены произвольные.
3. Десктоп, открытый с хоста `localhost` (так Tauri работает на части платформ), SDK может принять за dev-среду. Но лицензия определяет продакшн по использованию, так что это не лазейка.
4. Лицензия запрещает перелицензирование, то есть tldraw — несвободный компонент внутри свободного проекта.
5. Sync — на JS и под той же лицензией.

MIT-лицензия «starter kits» не меняет дела: они зависят от SDK.

### 14. Другие варианты, коротко

| Вариант | Версия, дата | Лицензия (проверено) | Что это | Почему не движок досок Strata |
|---|---|---|---|---|
| **BlockSuite** edgeless (AFFiNE) | `@blocksuite/affine` 0.22.4, 2025-07-01. Отдельный репозиторий стоит с 2025-07-07 («sync affine blocksuite to packages») | Репозиторий `toeverything/blocksuite` — MPL-2.0. Код теперь в монорепо AFFiNE (`blocksuite/**`) под MIT, кроме `packages/backend` (Enterprise-лицензия) ([LICENSE AFFiNE](https://github.com/toeverything/AFFiNE/blob/canary/LICENSE)) | Блочный редактор + edgeless-холст на Lit (web components), CRDT — Yjs | Завязан на Yjs и модель блоков AFFiNE, а у Strata — Loro (R3). Сам README пишет «currently in its early stage». Пакеты `@blocksuite/*` под тегом `latest` не обновлялись с 2025-07-01 |
| **Penpot** | ветка `develop` | MPL-2.0 ([LICENSE](https://github.com/penpot/penpot/blob/develop/LICENSE)) | Полноценная платформа дизайна: self-hosted через Docker, плагины, MCP-сервер ([README](https://github.com/penpot/penpot)) | Не встраиваемый компонент, а отдельный продукт со своим сервером. Избыточен |
| **draw.io** | `VERSION` 32.4.1 в ветке `dev` | Apache-2.0. Иконки и стенсилы нельзя использовать в продуктах Atlassian ([README](https://github.com/jgraph/drawio)) | Редактор диаграмм на mxGraph, встраивается через iframe | «We do not accept pull requests», «does not support real-time collaborative editing». Диаграммы, а не мудборд. Годится разве что для отдельного вида ноды «диаграмма» позже |
| **Konva** + react-konva | 10.8.0 (2026-10-12), react-konva 19.3.0 | MIT ([LICENSE](https://github.com/konvajs/konva/blob/master/LICENSE)) | Граф сцены на Canvas 2D: события, drag, трансформации, кэш, экспорт ([README](https://github.com/konvajs/konva)) | Это кирпич, а не доска. Готовый редактор с правкой текста мейнтейнеры продают отдельно (Polotno, коммерческий). Добавил бы второй 2D-рендер рядом с PixiJS |
| **Fabric.js** | 7.4.0 (2026-05-18) | MIT ([LICENSE](https://github.com/fabricjs/fabric.js/blob/master/LICENSE)) | Объектная модель на canvas, ввод и вывод JPG/PNG/JSON/SVG ([README](https://github.com/fabricjs/fabric.js)) | То же: стрелки с привязками, фреймы, совместную работу и undo пришлось бы писать самим |
| **Leafer UI** | 2.3.1 (2026-10-08) | MIT | Быстрый canvas-движок с плагином-редактором. Заявлен 1 млн интерактивных прямоугольников — данные вендора, не проверено ([README](https://github.com/leaferjs/leafer-ui)) | Документация в основном на китайском. Второй рендер рядом с PixiJS |
| **Plait / Drawnix** | `@plait/core` 0.94.1 (2026-09-23) | MIT ([LICENSE Drawnix](https://github.com/plait-board/drawnix/blob/develop/LICENSE)) | Доска с mind map, flowchart, свободным рисованием, Mermaid ([README](https://github.com/plait-board/drawnix)) | В README среди возможностей нет синхронизации в реальном времени, только автосохранение в браузер. Свой формат `.drawnix`, акцент на mind map и flowchart, которые у Strata и так на холсте сетей |
| **Quickdraw** | `@quickdrawjs/react` 0.3.0 (2026-10-12) | MIT ([LICENSE](https://github.com/quickdrawjs/quickdraw/blob/main/LICENSE)) | Позиционирует себя как MIT-альтернативу tldraw | Версия 0.3, около 30 звёзд по данным агрегатора. Стоит следить, но не брать |

### 15. Вариант без отдельного движка: доска на холсте Strata (PixiJS)

Что пришлось бы написать на PixiJS 8 (R4), чтобы закрыть «Miro-подобную доску референсов»:

| Подсистема | Сложность | Комментарий |
|---|---|---|
| Картинки: вставка, перетаскивание, ресайз, обрезка, LOD-текстуры из миниатюр | средняя | Здесь свой движок **сильнее** Excalidraw: мипмапы, выгрузка текстур, тысячи картинок |
| Выделение, рамка выделения, трансформ-ручки, привязки и направляющие, выравнивание | средняя | Частично общая с холстом сетей (выделение, rbush) |
| Текст на холсте с редактированием | высокая | DOM-оверлей для ввода (IME, кириллица), MSDF для отображения |
| Стрелки с привязкой к объектам, подписи, ломаные | высокая | В Excalidraw на это ушли годы (elbow arrows, binding) |
| Свободное рисование | низкая | `perfect-freehand` 1.2.3 (MIT) |
| Фреймы и группы, z-порядок, копирование и вставка, дублирование | средняя | — |
| Undo/redo с учётом совместной работы | средняя | Loro `UndoManager` с `groupStart/groupEnd` |
| Экспорт PNG/SVG | средняя | PNG — `extract` из Pixi, SVG — свой сериализатор |
| Виджеты to-do и заметок | низкая | Свои, как и в варианте с Excalidraw |

Оценка: 3–6 человеко-месяцев до уровня подмножества Excalidraw (оценка, не проверено). Сюда не входит совместимость с `.excalidraw.md`, которая у Excalidraw есть даром.

Плюсы: единый вид (туман, гравюра, пиксельные шрифты на холсте), единые навигация и хоткеи с холстом сетей, доска рисуется прямо в баббле или в 3D, нет второго мира React и Canvas 2D, полный контроль памяти под картинки. Минусы: срок, риск для MVP, всё «как в Excalidraw» пришлось бы догонять.

**Компромисс, который стоит заложить сразу:** свой **рендер только для чтения** подмножества элементов (картинки, прямоугольники, текст, виджеты) на PixiJS. Он нужен для превью доски в баббле, «подглядывания» без входа и 3D-карточек — данные это обычный JSON. Это недели работы, а не месяцы, и он же станет фундаментом, если позже придётся уходить с Excalidraw.

## Сравнение вариантов

| Критерий | Excalidraw 0.18.1 | Excalidraw `next` (закреплённый снапшот) | Мягкий форк Excalidraw | tldraw 5.5 | BlockSuite edgeless | Свой редактор на PixiJS |
|---|---|---|---|---|---|---|
| Лицензия для open source + self-hosted | ✅ MIT | ✅ MIT | ✅ MIT | ❌ ключ у каждого, хобби с водяным знаком | ⚠️ MPL-2.0 или MIT (в AFFiNE) | ✅ своя |
| Стабильность API | ✅ заморожен | ⚠️ снапшоты, переименования | ⚠️ на нас | ✅ semver | ⚠️ «early stage», нет релизов с 2025-07 | на нас |
| Свои виджеты (to-do, заметка) | ✅ `renderEmbeddable` (DOM поверх) | ✅ то же | ✅ можно и слой исправить | ✅ кастомные фигуры | ⚠️ блоки AFFiNE | ✅ |
| Свои инструменты | ✅ `custom` | ✅ + `activeTool` | ✅ | ✅ `StateNode` | ⚠️ | ✅ |
| Свои типы элементов | ❌ | ❌ | ✅ | ✅ | ⚠️ | ✅ |
| Свой UI вместо встроенного | ⚠️ CSS-хаки | ✅ `ui={false}` | ✅ | ✅ | ⚠️ | ✅ |
| Пиксельный шрифт на холсте | ❌ | ❌ | ✅ (`registerLocalFont`-подобный патч) | ✅ темы v5 | ⚠️ | ✅ |
| Картинки во внешнем хранилище | ⚠️ `generateIdForFile` + `addFiles`, 1440 px | ✅ + `imageOptions` | ✅ + выгрузка файлов | ✅ `TLAssetStore` с `resolve` по масштабу | ⚠️ свой blob-слой | ✅ |
| Биндинг к Loro | ⚠️ дифф `onChange` | ✅ дельты `onIncrement` | ✅ | ❌ свой sync на JS | ❌ Yjs | ✅ нативно |
| Совместимость с Obsidian Excalidraw | ✅ та же сцена (без стикеров) | ✅ (стикеры знает форк плагина) | ✅ | ❌ | ❌ | ⚠️ через конвертер |
| Время до MVP | 4–7 недель (оценка) | 4–7 недель (оценка) | +2–4 недели на патчи (оценка) | — | — | 3–6 месяцев (оценка) |
| Вердикт | запасной | **MVP** | если упрёмся | ❌ | ❌ | этап 2+ при необходимости |

Требования владельца и то, как их закрывает рекомендованный вариант:

| Требование | Как закрывается |
|---|---|
| E1: уровень Excalidraw, инструменты дорабатываются позже | Excalidraw как есть. Доработка: свои инструменты (`custom`), виджеты (`embeddable`), при нужде — патчи и форк |
| C2: на доске короткие заметки и to-do | Виджеты Strata в `embeddable`, данные в Loro с посимвольным слиянием |
| Совместная работа обязательна | LWW по элементу в Loro, эфемерный канал для жестов, курсоры через `collaborators` |
| Ленивая загрузка | Документ доски грузится при открытии ноды. Картинки — рабочими копиями по видимой области |
| `[[wikilinks]]` создают нити | Разбор текста виджетов-заметок и текстовых элементов при сохранении → нити с `origin=text` (05-domain-model §13) |
| Дизайн: туман, гравюра, ретро-окна | Прозрачный фон доски поверх тумана, свой UI (`ui={false}`), виджеты в стиле Strata. Пиксельный шрифт на холсте — позже, через форк |
| MCP: AI кладёт картинки на доски | Доменные операции `board.addImage` / `addNote` / `addTodo` пишут элементы в Loro-документ, клиенты получают их как удалённые правки |
| Импорт vault Obsidian (MVP) | `.excalidraw.md` → нода-доска без потерь |

## Рекомендация для Strata

### MVP: Excalidraw `next` за адаптером

1. **Версия.** Разрабатываем на **закреплённом снапшоте `next`** (точная версия, например `0.18.0-43a92e6`, без `^`). Из него нужны `ui={false}`, `onIncrement`, `imageOptions`, `activeTool`, `stickynote`. Обновление снапшота — осознанная задача с прогоном тестов биндинга. Если до релиза MVP выйдет стабильный 0.19, переходим на него. Запасной путь — 0.18.1: биндинг через дифф `onChange`, UI через CSS, картинки до 1440 px.
2. **Адаптер `BoardEngine`** (TypeScript, один модуль): `mount(container, doc)`, `setTool(tool)`, `insertWidget(kind)`, `insertImage(sha256)`, `exportThumbnail()`, `destroy()`. Всё специфичное для Excalidraw — внутри: переименования API, `customData`, `reconcileElements`. Остальная Strata видит только адаптер и Loro-документ.
3. **Окно доски** — ретро-окно Strata (DOM, R7). Внутри — Excalidraw с `ui={false}`, рядом свой пиксельный тулбар и панель свойств, которые зовут `setActiveTool` и `updateScene`. Тема `light`, `viewBackgroundColor: "transparent"`, за доской — туманный фон Strata. По умолчанию `roughness: 0` и палитра Strata в `colorTopPicks`. Excalifont или Nunito (кириллица есть) — по выбору пользователя. Шрифты и ассеты Excalidraw кладём в сборку (`EXCALIDRAW_ASSET_PATH`). Внешние функции выключаем: `aiEnabled={false}`, без каталога библиотек.
4. **Хоткеи.** `U`, `Tab` и путь Strata перехватываем в фазе capture до Excalidraw. `L` внутри доски остаётся линией (контекст окна). Колесо и средняя кнопка ведут себя как на холсте сетей (`appState.inputDevice` в `next`).

### Схема данных доски (документ содержимого `content/{boardNodeId}`, Loro)

```ts
// content/{boardNodeId} — LoroDoc, грузится только при открытии доски
meta:     LoroMap  { schema: 1, engine: "excalidraw@0.18.0-43a92e6",
                     viewBackgroundColor, gridSize }          // без scroll/zoom: это локальное состояние
elements: LoroMap<elementId, ExcalidrawElementJSON>           // LWW на элемент, isDeleted = tombstone
files:    LoroMap<fileId, { sha256, mime, w, h, created }>    // байты — в хранилище ассетов
widgets:  LoroMap<widgetId, LoroMap {
            kind: "note" | "todo",
            text?:  LoroText,                                  // note: Markdown, [[ссылки]] → нити
            items?: LoroMovableList<LoroMap { id, text: LoroText, done: boolean }>
          }>
```

- **Элемент-виджет:** `{type: "embeddable", link: "strata://widget/<widgetId>", customData: {strata: {widget: "todo", v: 1}}}`. Геометрия, слой и фрейм — в `elements`, содержимое — в `widgets`.
- **`fileId` → `sha256`** храним через карту `files`, а не равенством: при импорте из Obsidian `fileId` — чужие SHA-1, а у новых вставок `fileId` = SHA-256 (через `generateIdForFile`). Это совпадает со схемой R3 §9.
- **Tombstones.** Элементы с `isDeleted` старше N дней сервер чистит при компактировании. У excalidraw.com срок — сутки, нам нужно больше из-за офлайна. Срок связан с вопросом R3 об окне офлайна.

### Биндинг Excalidraw ↔ Loro

| Направление | Как |
|---|---|
| Локальное → CRDT | `onIncrement`: `DurableIncrement` → для изменённых id `elements.set(id, element)`, один `commit({origin: "board:local"})` на жест. `EphemeralIncrement` (перетаскивание, ресайз) → эфемерное хранилище Loro (`EphemeralStore`), не чаще 30 Гц, как у excalidraw.com. На 0.18.1 — дифф `onChange` по карте `id → version` |
| CRDT → локальное | Подписка на документ → изменённые ключи → `reconcileElements(local, remote, appState)` (защищает элементы, которые сейчас редактируются) → `updateScene({elements, captureUpdate: CaptureUpdateAction.NEVER})` |
| Курсоры и выделения | `onPointerUpdate` → эфемерное хранилище → `updateScene({collaborators})` |
| Undo | Сцена — встроенная история Excalidraw: удалённые правки с `NEVER` в неё не попадают. Текст и пункты виджетов — Loro `UndoManager` на контейнерах виджета, пока фокус внутри виджета. Проверить в спайке, что два стека не путают пользователя |
| Конфликты | Одновременная правка одного элемента → побеждает один, детерминированно (LWW в Loro). Для подписей приемлемо; поэтому длинный текст живёт в виджетах с посимвольным слиянием |

### Виджеты

- **Заметка** (`note`): в режиме просмотра — статичный HTML из Markdown, при редактировании монтируется лёгкий CM6 (как в заметках, R4) на `LoroText`. `[[ссылки]]` в виджете создают нити от ноды-доски с `origin=text` и пересчитываются при сохранении. Нативный `stickynote` из `next` оставляем для быстрых пометок «на полях»: он рисуется на холсте и попадает в экспорт, но сливается LWW.
- **To-do** (`todo`): список пунктов на `LoroMovableList`. Отметка `done` — LWW по пункту, текст пункта — `LoroText`, порядок — перемещения без дублей.
- **Инструменты:** «Заметка» и «To-do» в тулбаре Strata — это `custom`-инструменты. Клик или протяжка создают элемент `embeddable` и запись в `widgets` одной транзакцией.
- **Экспорт и миниатюры:** перед `exportToBlob`/`exportToSvg` виджеты временно заменяются текстом и прямоугольниками через `convertToExcalidrawElements`.
- 💡 Позже — виджет «карточка ноды» `strata://node/<id>`: баббл с иконкой и статусом, двойной клик — нырок в ноду. Связывает доску референсов с графом.

### Картинки

1. При вставке или перетаскивании `generateIdForFile(file)` считает SHA-256 **оригинала** и в том же колбэке кладёт оригинал в хранилище ассетов: локально — CAS на диске, на сервере — загрузка. В `files` пишем метаданные.
2. Excalidraw получает **рабочую копию**: WebP с длинной стороной до 2048 px (💡 настройка пространства, до 4096) через `imageOptions`.
3. При открытии доски `addFiles` вызывается только для картинок в видимой области с запасом, по `onScrollChange` догружаются остальные. Оригинал открывается в просмотрщике по двойному клику.
4. AI-генерация (R6): MCP-операция `board.addImage(boardId, sha256, x, y, w, h)` создаёт ассет и элемент `image` с `status: "saved"`. Сервер заполняет `seed`, `version`, `versionNonce` и дробный `index`, чтобы клиенты не расходились при `restore`.

### Совместимость с Obsidian

- **Импорт** (MVP): `.excalidraw.md` → нода-доска. Распаковка LZString, элементы как есть, `## Embedded Files` → ассеты, `[[ссылки]]` в текстах и `link` → нити. Парсер пишем сами (AGPL, R2).
- **Экспорт и зеркало** (этап 2, отвечает на вопрос 8 из R2): доска → `.excalidraw.md` с несжатым блоком `json` (дружелюбнее к git). Картинки уходят файлами в vault, виджеты — элементами `embeddable` с `[[Доска/виджет.md]]` и сгенерированными `.md`, где to-do записаны как `- [ ]`. Двустороннее зеркало реально, потому что слияние идёт по элементам и их `version`.

### Долгосрочно

| Этап | Что делаем | Триггер |
|---|---|---|
| MVP | Excalidraw `next` за адаптером, виджеты, ассеты, биндинг Loro, импорт из Obsidian | — |
| MVP+1 | Свой рендер доски только для чтения на PixiJS: превью в баббле, «подглядывание», 3D-карточки. Экспорт в `.excalidraw.md` | Нужно превью без загрузки Excalidraw |
| Этап 2 | Мягкий форк: пиксельный шрифт на холсте, выгрузка файлов, виджеты без «активации» | Дизайн или память упёрлись в ограничения |
| Этап 3 (по необходимости) | Свой редактор на PixiJS **на той же схеме элементов** (подмножество Excalidraw + `customData.strata`) | Форк стал дороже собственного кода, или нужна правка доски прямо на холсте сетей и в 3D |

Главный принцип: **формат данных — схема элементов Excalidraw плюс расширения в `customData` и `widgets`**. Он не привязан к компоненту, совместим с Obsidian и переживёт смену движка.

### Спайк до ADR-0006 (💡, 1–2 недели)

1. Excalidraw `next` в окне Strata (React 19, Tauri и браузер): `ui={false}` и свой тулбар, прозрачный фон поверх тумана, 2 000 элементов и 200 картинок с рабочими копиями. Замерить p95 кадра и память.
2. Биндинг `onIncrement` ↔ Loro: 3 клиента, одновременное перетаскивание групп, правка одного текста, офлайн на 1 час с последующим слиянием.
3. Виджет to-do: два клиента одновременно отмечают и переставляют пункты. UX «активации» и Undo внутри и снаружи виджета.
4. Импорт трёх реальных `.excalidraw.md` из vault владельца (сжатые и несжатые, с картинками) и экспорт обратно с открытием в Obsidian.

## Риски

1. **Темп релизов Excalidraw.** Стабильный 0.18 заморожен с 2025-03, новое API есть только в снапшотах `next`, и оно ломается (`excalidrawAPI` → `onExcalidrawAPI`, `scrollToContent` → `setViewport`, `setActiveTool(tool, bool)` → `(tool, {keepSelection})`). Смягчение: точная версия, адаптер, тесты биндинга, запасной путь на 0.18.1.
2. **Виджеты в DOM-слое.** Они всегда поверх рисунка, требуют клика-активации, остаются смонтированными после первого показа, не попадают в экспорт, а пиксельные шрифты в них мылятся при дробном зуме. Смягчение: лёгкий режим просмотра, конвертация для экспорта, патч в форке позже.
3. **Память под картинки.** Excalidraw держит все добавленные файлы в `dataURL` и не умеет их выгружать. Доска с сотнями фото в полном разрешении «съест» гигабайты. Смягчение: рабочие копии и ленивое `addFiles`. Если не хватит — `removeFiles` в форке или свой рендер.
4. **LWW на элемент.** Одновременная правка одной подписи теряет одну из версий. Для длинного текста используем виджеты.
5. **Рост истории.** Каждая правка элемента сохраняет его целиком: 650 байт в среднем, у `freedraw` — килобайты. Смягчение: коммит по жесту, эфемерный канал, shallow-снапшоты и очистка tombstones на сервере.
6. **Два стека undo** (Excalidraw и Loro для виджетов) — возможна путаница в UX.
7. **Генерация на сервере.** MCP-сервер на Rust должен писать валидные элементы (дробный `index`, `seed`, `versionNonce`) и следить за схемой при обновлениях Excalidraw. Отрисовать миниатюру без JS и DOM он не сможет.
8. **Ограниченный стиль внутри доски:** только две темы, цвета инвертируются в тёмной, шрифты зашиты. Ретро-эстетика достигается рамкой и виджетами, а не холстом, пока нет форка.
9. **Конфликт хоткеев** (`L` и др.) и двух моделей навигации (холст сетей против Excalidraw).
10. **Лицензии.** Код плагина Obsidian Excalidraw (AGPL-3.0) нельзя копировать без совместимой лицензии Strata. tldraw нельзя тянуть даже транзитивно, включая MIT-«starter kits», которые зависят от SDK.
11. **Сеть по умолчанию.** Excalidraw берёт шрифты с `esm.sh`, а Mermaid и AI-функции могут ходить наружу. Для local-first и приватности всё это нужно отключить или переложить в сборку.
12. **Совместимость стикеров.** Элемент `stickynote` из `next` не поймут Excalidraw 0.18.1 и excalidraw.com на старой версии: `restore` его выбросит. При экспорте во внешние форматы конвертируем стикер в прямоугольник с текстом.

## Открытые вопросы

- **Q-R5-1.** Пункты to-do на доске — это «задачи» Strata (статус, дедлайн, ответственный, видны в линзах, канбане и свёртках) или простые галочки? Если задачи, пункт виджета должен ссылаться на ноду или быть ею, и модель данных (05) меняется.
- **Q-R5-2.** Нужны ли на доске карточки существующих нод (референс-нода проекта на мудборде, нырок по двойному клику)? Создают ли такие карточки нити от доски?
- **Q-R5-3.** Устраивает ли «рисованный» вид Excalidraw внутри доски, или доска должна выглядеть строго (без rough-линий и рукописного шрифта)? Нужен ли пиксельный шрифт **на холсте доски** (тогда форк) или достаточно ретро-рамки и виджетов?
- **Q-R5-4.** Сколько картинок ожидается на одной доске (50, 500, больше) и нужен ли доступ к оригиналу в полном разрешении прямо на доске? От этого зависят размер рабочих копий и потребность в форке или своём рендере.
- **Q-R5-5.** Можно ли разрабатывать на снапшотах `next` Excalidraw (не релизных), или нужен строго стабильный релиз ценой отказа от `ui={false}` и `onIncrement`?
- **Q-R5-6.** Нужен ли экспорт досок обратно в формат плагина Obsidian Excalidraw: разово, постоянным зеркалом или не нужен (продолжение вопроса 8 из R2)?
- **Q-R5-7.** Важно ли рисование пером и планшетом (`freedraw`, давление)? Это влияет на объём истории и приоритет оптимизаций.
- **Q-R5-8.** Может ли AI через MCP менять существующие элементы доски (двигать, удалять, переписывать) или только добавлять новые: картинки, заметки, to-do?
- **Q-R5-9.** Лицензия Strata (MIT или AGPL)? От неё зависит, можно ли заимствовать решения из кода плагина Obsidian Excalidraw (AGPL-3.0) и как оформлять форк Excalidraw.

## Источники

**Excalidraw**
- https://www.npmjs.com/package/@excalidraw/excalidraw
- https://github.com/excalidraw/excalidraw/blob/master/LICENSE
- https://github.com/excalidraw/excalidraw/releases
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/CHANGELOG.md
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/types.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/App.tsx
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/Tools.tsx
- https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/types.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/embeddable.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/image.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/store.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/renderElement.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/restore.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/blob.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/scene/Renderer.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/helpers.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/staticSvgScene.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/Fonts.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/ExcalidrawFontFace.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/css/theme.scss
- https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/colors.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/utils.ts
- https://github.com/excalidraw/excalidraw/blob/master/packages/utils/src/export.ts
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/data/FileManager.ts
- https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/app_constants.ts
- https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/props/props.mdx
- https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/props/render-props.mdx
- https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton.mdx
- https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/@excalidraw/excalidraw/api/utils/export.mdx
- https://github.com/excalidraw/excalidraw/issues
- https://github.com/excalidraw/excalidraw-room
- https://github.com/excalidraw/excalidraw-room/blob/master/src/index.ts
- https://github.com/excalidraw/excalidraw-libraries
- https://www.npmjs.com/package/@excalidraw/mermaid-to-excalidraw

**Биндинги и плагин Obsidian**
- https://github.com/RahulBadenkal/y-excalidraw
- https://github.com/loro-dev/loro-excalidraw
- https://github.com/zsviczian/obsidian-excalidraw-plugin
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/excalidrawMarkdownParsing.ts
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/ExcalidrawData.ts
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/view/managers/ViewExcalidrawExtensionRenderer.ts
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/core/managers/FontManager.ts
- https://www.npmjs.com/package/@zsviczian/excalidraw

**tldraw**
- https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- https://tldraw.dev/community/license (исходник: https://github.com/tldraw/tldraw/blob/main/apps/docs/content/community/license.mdx)
- https://tldraw.dev/sdk-features/license-key (исходник: https://github.com/tldraw/tldraw/blob/main/apps/docs/content/sdk-features/license-key.mdx)
- https://tldraw.dev/pricing
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/releases/v4.0.0.mdx
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/releases/v5.0.0.mdx
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/shapes.mdx
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/tools.mdx
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/assets.mdx
- https://github.com/tldraw/tldraw/blob/main/apps/docs/content/docs/sync.mdx
- https://www.npmjs.com/package/tldraw

**Другие варианты**
- https://github.com/toeverything/blocksuite
- https://github.com/toeverything/AFFiNE/blob/canary/LICENSE
- https://www.npmjs.com/package/@blocksuite/affine
- https://github.com/penpot/penpot
- https://github.com/penpot/penpot/blob/develop/LICENSE
- https://github.com/jgraph/drawio
- https://github.com/konvajs/konva
- https://github.com/konvajs/konva/blob/master/LICENSE
- https://www.npmjs.com/package/konva
- https://www.npmjs.com/package/react-konva
- https://github.com/fabricjs/fabric.js
- https://github.com/fabricjs/fabric.js/blob/master/LICENSE
- https://www.npmjs.com/package/fabric
- https://github.com/leaferjs/leafer-ui
- https://github.com/plait-board/drawnix
- https://www.npmjs.com/package/@plait/core
- https://github.com/quickdrawjs/quickdraw
- https://www.npmjs.com/package/perfect-freehand

**Связанные исследования Strata**
- [R2 — формат Obsidian](R2-obsidian-format.md)
- [R3 — CRDT и синхронизация](R3-crdt-sync.md)
- [R4 — оболочка и рендер](R4-app-shell-rendering.md)
