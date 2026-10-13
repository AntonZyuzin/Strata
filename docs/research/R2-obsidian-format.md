# R2. Формат хранилища Obsidian и JSON Canvas: импорт, экспорт, живое зеркало

> Дата исследования: 2026-10-13. Актуальные версии на эту дату: Obsidian 1.13 — публичная (вышла 2026-07-30), 1.14.x — insider (1.14.3 от 2026-09-29), `obsidian-api` 1.14.4. Основной первоисточник — исходники справки Obsidian в репозитории [obsidianmd/obsidian-help](https://github.com/obsidianmd/obsidian-help) (коммит `08ef563` от 2026-10-11). Это тот же текст, что на help.obsidian.md, ниже даны ссылки на опубликованные страницы. Сайты help.obsidian.md, jsoncanvas.org и forum.obsidian.md из среды исследования напрямую не открывались. Поэтому данные с форумов взяты из выдачи поиска и помечены «по данным поиска».

## Кратко

- **Vault — это просто папка** с `.md`, `.canvas`, `.base` и вложениями. Настройки лежат в `.obsidian/`. Ключи `app.json` официально не документированы, но стабильны: `useMarkdownLinks`, `newLinkFormat`, `attachmentFolderPath`, `newFileLocation`, `alwaysUpdateLinks`, `userIgnoreFilters`. Их нужно читать при импорте и учитывать при записи. Писать в `.obsidian/` нельзя.
- **Ссылки** бывают двух равноправных форматов: `[[wikilink]]` и `[md](link.md)`. К ним добавляются якоря `#Heading`, `#^block-id`, текст `|alias`, вложения `![[…]]` с размером `|300` или `|640x480`. Разрешение по «кратчайшему пути» неоднозначно при одинаковых именах файлов в разных папках, поэтому импорт обязан выдавать отчёт о неоднозначностях.
- **Properties (YAML)** поддерживают 7 типов: Text, List, Number, Checkbox, Date, Date & time, Tags. Ссылки в свойствах пишутся в кавычках (`"[[X]]"`). Они попадают в Backlinks с 1.4.4 (2023-08), а с 1.11 (2026-01) поддерживаются Markdown-ссылки и автообновление при переименовании. Obsidian **переписывает весь frontmatter** при любой правке свойства: пропадают комментарии, меняется стиль списков. Это главный источник «пинг-понга» при живом зеркале.
- **JSON Canvas 1.0** (2024-03-11, MIT) — простой граф. В нём 4 типа нод (text/file/link/group) и рёбра с `fromSide/toSide/fromEnd/toEnd/color/label`, 6 цветовых пресетов без фиксированных RGB, членство в группах только геометрическое. Он почти 1:1 ложится на «сеть Strata с раскладкой». Один файл-заметку можно положить в много канвасов, и это нативно решает переиспользование ноды в нескольких местах.
- **Bases** (`.base`, YAML; ядро с 1.9, публично с 2025-08-18) хранят только **представления** над properties, данных в них нет. Из Strata их достаточно генерировать при экспорте (например, канбан задач по `status`; Kanban-layout появился в 1.14). Импортировать их стоит как «сохранённый запрос», не в MVP.
- **Форматы плагинов** разбираются без самих плагинов. Excalidraw: `.excalidraw.md`, сцена в блоке `compressed-json`, сжатие LZString base64. Tasks: эмодзи `📅 ⏳ 🛫 ✅ ❌ 🔁 🆔 ⛔` и приоритеты. Dataview: `key:: value`. Kanban: `kanban-plugin: board`, колонки `##`, настройки в `%% kanban:settings %%`. Код плагинов под GPL/AGPL копировать нельзя, писать свои парсеры по формату.
- **Живое двустороннее зеркало опасно.** Внешние переименования Obsidian не распознаёт и ссылки не чинит. Открытый в редакторе файл может затереть внешнюю правку: свежий баг-репорт на 1.13.1. Dot-папки Obsidian не индексирует, а Obsidian Sync их не синхронизирует. Canvas при конфликте Sync решается по правилу «последний победил».
- **Рекомендация:** источник правды — собственное хранилище Strata (CRDT, см. R3), Obsidian — проекция. В MVP: импорт без потерь «насколько возможно» плюс экспорт по запросу. Позже: зеркало «Strata → папка» с ограниченным приёмом обратных правок (только текст и frontmatter `.md`). Схема метаданных: `strata-id` и семантические атрибуты во frontmatter, раскладка сети в `.canvas` (виден и полезен в Obsidian), `.strata/` только для восстановимого кэша.

## Находки

### 1. Структура хранилища и `.obsidian/`

**Базовые правила** ([data-storage](https://help.obsidian.md/data-storage), [configuration-folder](https://help.obsidian.md/configuration-folder)):
- Vault — папка с подпапками. Obsidian «автоматически обновляет хранилище при внешних изменениях». Вложенные vault не рекомендуются: «Links may not be updated correctly».
- Конфигурация лежит в `.obsidian/` в корне vault. Имя можно переопределить (`Override config folder`, «Must start with a dot»), поэтому импорт должен искать любую dot-папку с `app.json`, а не только `.obsidian`.
- `.obsidian/workspace.json` и `workspaces.json` меняются при каждом открытии файла (рекомендуют добавлять в `.gitignore`). Watcher Strata должен их игнорировать.
- Кэш метаданных Obsidian хранится в IndexedDB, вне папки. Для внешнего приложения он недоступен, и это не нужно.
- Удалённые файлы попадают в системную корзину, в `.trash/` внутри vault или удаляются насовсем ([settings](https://help.obsidian.md/settings#Trash)). `.trash/` нужно игнорировать.
- Symlinks Obsidian «strongly advise against». Изменения файловых симлинков «aren't watched for». Перемещение через границу устройств Obsidian видит как «удаление + создание» и **не обновляет ссылки** ([symlinks](https://help.obsidian.md/symlinks)).
- Поддерживаемые форматы ([file-formats](https://help.obsidian.md/file-formats)): `.md`, `.base`, `.canvas`; изображения `avif bmp gif jpeg jpg png svg webp`; аудио `flac m4a mp3 ogg wav webm 3gp`; видео `mkv mov mp4 ogv webm`; `pdf`.
- Папки и файлы, начинающиеся с точки, Obsidian не показывает и не индексирует. Obsidian Sync их не синхронизирует (по данным поиска: [forum 26908](https://forum.obsidian.md/t/enable-use-access-to-hidden-files-and-folders-starting-with-a-dot-dotfiles-dotfolders-within-obsidian/26908), [forum 32123](https://forum.obsidian.md/t/obsidian-sync-sync-hidden-files-and-folders-as-well-start-with-a-dot/32123)). Вывод: `.strata/` невидима в Obsidian, но и **не доедет** до других устройств пользователя Obsidian Sync.

**Настройки «Files and links»** ([settings](https://help.obsidian.md/settings#Files%20and%20links)) и их ключи в `app.json`. Ключи официально не документированы. Они взяты из реальных конфигов на GitHub ([поиск](https://github.com/search?q=filename%3Aapp.json+newLinkFormat+attachmentFolderPath&type=code)) и из эмуляции vault в официальном [obsidian-importer](https://github.com/obsidianmd/obsidian-importer/blob/master/web/obsidian/vault.ts), MIT.

| Настройка в UI | Ключ `app.json` | Значения | Что делает Strata |
|---|---|---|---|
| Default location for new notes | `newFileLocation`, `newFileFolderPath` | `root` / `current` / `folder` | Куда класть новые ноды при экспорте и зеркале |
| Default location for new attachments | `attachmentFolderPath` | `/` — корень (по умолчанию), `./` — рядом с заметкой, `./sub` — подпапка, `path` — заданная папка | Куда класть медиа-ноды |
| New link format | `newLinkFormat` | `shortest` / `relative` / `absolute` | Формат генерируемых ссылок |
| Use [[Wikilinks]] | `useMarkdownLinks` | `false` = wikilinks (по умолчанию) | Wikilink или Markdown при записи |
| Automatically update internal links | `alwaysUpdateLinks` | bool | Знать, будет ли Obsidian сам переписывать ссылки |
| Excluded files | `userIgnoreFilters` | массив путей и regex | Не импортировать и не трогать |
| Show all file types | `showUnsupportedFiles` | bool | — |

Другие файлы, которые безопасно **читать** (только чтение):
- `.obsidian/types.json` — реестр типов свойств вида `{"types": {"due": "date", "topics": "multitext", …}}`. Внутренние имена: `text`, `multitext` (List), `number`, `checkbox`, `date`, `datetime`, `aliases`, `tags` ([примеры](https://github.com/search?q=path%3A.obsidian+filename%3Atypes.json+multitext&type=code)). С 1.6 Obsidian перечитывает его при внешнем изменении ([v1.6](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.6.md)).
- `.obsidian/daily-notes.json` — `{"folder", "format" (moment.js), "template"}` ([примеры](https://github.com/search?q=filename%3Adaily-notes.json+path%3A.obsidian&type=code), [daily notes](https://help.obsidian.md/plugins/daily-notes)).
- `.obsidian/community-plugins.json` — массив id включённых плагинов (`obsidian-excalidraw-plugin`, `dataview`, `obsidian-kanban`, `obsidian-tasks-plugin` и т. д.). По нему импорт решает, какие парсеры включать. `.obsidian/plugins/<id>/data.json` хранит настройки плагинов: папку Excalidraw, global filter Tasks. Формат зависит от плагина.

### 2. Синтаксис ссылок и правила разрешения

Источник: [links](https://help.obsidian.md/links), [embeds](https://help.obsidian.md/embeds), [obsidian-flavored-markdown](https://help.obsidian.md/obsidian-flavored-markdown).

- Два равноправных формата. `[[Three laws of motion]]` ≡ `[[Three laws of motion.md]]` ≡ `[Three laws of motion](Three%20laws%20of%20motion.md)`. В Markdown-формате путь **URL-кодируется** (`%20`). Пути к папкам считаются от корня vault через `/` даже на Windows.
- Ссылки на не-`.md` файлы требуют расширения: `[[Figure 1.png]]`.
- Ссылка на заголовок: `[[Note#Heading]]`. На подзаголовок: `[[Note#H1#H2]]`. Внутри той же заметки: `[[#Heading]]`.
- Ссылка на блок: `[[Note#^37066d]]`. Определение блока: ` ^id` в конце абзаца. Для списков, цитат, callout и таблиц id ставится **отдельной строкой** с пустыми строками вокруг. Id блока — «only Latin letters, numbers, and dashes». Ссылки на части цитат, callout и таблиц не поддерживаются.
- Отображаемый текст: `[[Note|Текст]]`, `[[Note#H|Текст]]`, `[Текст](Note.md#H)`.
- Опасные символы в именах: `# | ^ : %% [[ ]]` («may not work as a link»). С 1.11 переименование в такие имена даёт только предупреждение, а при импорте (drag&drop) Obsidian сам вычищает недопустимые символы ([v1.11](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.11.md)).
- Ссылка на несуществующую заметку допустима (в графе Obsidian это «призрак»). При клике заметка создаётся по пути из ссылки.
- **Вложения** `![[…]]`: заметка целиком, заголовок или блок (`![[Note#^id]]`); изображение с размером `![[img.jpg|640x480]]` или только шириной `|100`. Внешнее изображение задаётся как `![250](https://…)`, с 1.13 работает и в Reading mode. PDF: `![[Doc.pdf#page=3&height=400]]`. Canvas: `![[X.canvas]]` (показывает только формы, без текста). Base: `![[File.base#View]]`. Встраивание поиска делается кодблоком `query`.
- Прочий OFM-синтаксис, который нужно **сохранять байт-в-байт**: `%%comment%%`, `==highlight==` (с 1.14 insider цветные `==🔵 text==` ([v1.14](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.14.md))), callouts `> [!note]`, сноски `[^id]`, задачи `- [ ]`/`- [x]`, LaTeX, HTML (Markdown внутри HTML не рендерится).

**Разрешение ссылок.**
- API: `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)` возвращает «best match»: путь относительно источника или любой файл с таким хвостом пути. `fileToLinktext` генерирует basename, если имя уникально, иначе полный путь ([obsidian.d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)). `resolvedLinks` и `unresolvedLinks` — карты «источник → цель → счётчик».
- Эмуляция в официальном importer такая: сначала полный путь от корня (без учёта регистра), затем первый файл с тем же basename ([vault.ts](https://github.com/obsidianmd/obsidian-importer/blob/master/web/obsidian/vault.ts)). Это упрощение, а не эталон.
- При появлении дубликата имени Obsidian при генерации вставляет «кратчайший однозначный путь». Какой из дубликатов выигрывает у «голой» неоднозначной ссылки, официально не описано; на форуме говорят, что берётся «первый найденный» (по данным поиска: [forum 32110](https://forum.obsidian.md/t/disambiguiting-mutiple-files-with-the-same-name/32110)). Foam приводит таблицу совместимости и считает `[[todo]]` при двух `todo.md` ошибкой в обоих приложениях ([foam wikilinks](https://github.com/foambubble/foam/blob/main/docs/user/features/wikilinks.md)).
- **Переименование.** При `Automatically update internal links` Obsidian сам переписывает все ссылающиеся файлы. Это касается только переименований **внутри Obsidian** и через Obsidian CLI `move`/`rename` ([cli](https://help.obsidian.md/cli)). Переименования извне (Finder, скрипт, другое приложение) Obsidian не распознаёт, и ссылки ломаются (по данным поиска: [forum 40004](https://forum.obsidian.md/t/will-externally-renamed-files-lose-all-backlinks-do-settings-matter/40004), [forum 25682](https://forum.obsidian.md/t/auto-updated-links-rename-from-file-system/25682), [desktopcommander](https://desktopcommander.app/blog/obsidian-bulk-rename-files/)).

### 3. Properties (frontmatter)

Источник: [properties](https://help.obsidian.md/properties), release notes [1.4](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.md), [1.4.0](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.0.md).

- Properties появились в **1.4** (публично 2023-08-31). YAML стоит в начале файла. Допустим и JSON-frontmatter, который Obsidian «read, interpreted, and saved as YAML».
- Типы: **Text** (одна строка, Markdown не рендерится, `#` не создаёт тег), **List**, **Number** (только литерал), **Checkbox** (`true/false`, пусто = неопределённо), **Date** (`2020-08-21`), **Date & time** (`2020-08-21T10:30:00`), **Tags** (только для свойства `tags`). Тип назначается **имени свойства на весь vault**.
- Свойства по умолчанию: `tags`, `aliases`, `cssclasses` (все списки). Свойства Publish: `publish`, `permalink`, `description`, `image`, `cover`.
- Устаревшие `tag`, `alias`, `cssclass` объявлены deprecated в 1.4. Редактор свойств автоматически мигрирует их в `tags`/`aliases`/`cssclasses` со списками, а с 1.9 они больше не считаются свойствами по умолчанию. Импорт Strata должен понимать их как синонимы.
- Не поддерживаются: вложенные свойства (видны только в source mode), Markdown в значениях.
- **Ссылки в свойствах.** `link: "[[Episode IV]]"` и списки `- "[[Link]]"`, кавычки обязательны.
  - 1.4.0 (2023-07): в API появился `frontmatterLinks: FrontmatterLinkCache[]` с полем `key` ([obsidian.d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)).
  - 1.4.4 (2023-08-23): «Properties with links will now properly show in backlink entries» ([v1.4.4](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.4.md)).
  - 1.5.7 (2024-02-20): исправлено обновление ссылок в свойствах при переименовании ([v1.5.7](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.5.7.md)).
  - 1.11 (2026-01-12): Markdown-ссылки в text и list свойствах поддерживаются и автообновляются ([v1.11](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.11.md)).
  - **Graph view**: в официальной документации явно не сказано, что ссылки из свойств рисуются рёбрами. По сообщениям сообщества — рисуются, если ссылка в кавычках (по данным поиска: [forum 39851](https://forum.obsidian.md/t/frontmatter-link-in-the-graph/39851)). **Не проверено официально.**
- Если включён Daily notes, свойство-дата работает как ссылка на дневную заметку этой даты ([daily notes](https://help.obsidian.md/plugins/daily-notes)).
- **Obsidian переписывает frontmatter целиком** при правке любого свойства через UI или `processFrontMatter`. YAML превращается в JS-объект и сериализуется заново: комментарии удаляются, inline-списки `[a, b]` становятся блочными, кавычки меняются. Баг-репорты закрыты, менять это не планируют. Обходной путь — сторонний плагин Preserve Frontmatter Formatting (по данным поиска: [forum 65851](https://forum.obsidian.md/t/yaml-properties-api-processfrontmatter-removes-alters-string-quotes-comments-types-formatting/65851), [forum 69048](https://forum.obsidian.md/t/bug-using-the-properties-menu-deletes-yaml-comments-from-the-frontmatter/69048), [obsidianstats](https://www.obsidianstats.com/plugins/preserve-frontmatter-formatting)).
- С 1.14 insider исправлены лаги в больших vault из-за фонового пересчёта свойств. Это косвенный сигнал, что массовые правки frontmatter извне для Obsidian дороги ([v1.14](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.14.md)).

### 4. Теги и алиасы

- Теги ([tags](https://help.obsidian.md/tags)): `#tag` в тексте или список `tags:` во frontmatter (без `#`). Допустимы буквы, цифры, `_`, `-`, `/` и Unicode, включая эмодзи. Нужен хотя бы один нецифровой символ (`#1984` — не тег). Теги **регистронезависимы**, пробелы запрещены. Вложенные теги `#inbox/to-read`: поиск `tag:inbox` находит и вложенные, `file.hasTag("a")` в Bases совпадает с `#a/b`.
- Алиасы ([aliases](https://help.obsidian.md/aliases)) — список `aliases:`. При выборе алиаса в автодополнении Obsidian вставляет `[[Artificial Intelligence|AI]]`, а не `[[AI]]`, «to ensure interoperability». Алиасы участвуют в unlinked mentions. Для Strata это готовый источник альтернативных имён для нечёткого поиска по названиям нод.

### 5. JSON Canvas 1.0

Спецификация: [jsoncanvas.org/spec/1.0](https://jsoncanvas.org/spec/1.0/), исходник [spec/1.0.md](https://github.com/obsidianmd/jsoncanvas/blob/main/spec/1.0.md). Версия 1.0 от 2024-03-11. Лицензия **MIT** (LICENSE в репозитории). Других версий спецификации в репозитории нет (коммит от 2026-07-24).

- Верхний уровень: `nodes[]` и `edges[]`, оба необязательные. **Порядок в `nodes` = z-order**: первый элемент внизу.
- Общие поля ноды: `id`, `type` (`text|file|link|group`), `x`, `y`, `width`, `height` — **целые** пиксели; необязательный `color`.
  - `text`: `text` (Markdown).
  - `file`: `file` (путь от корня vault), `subpath` (`#Heading` или `#^block`).
  - `link`: `url`.
  - `group`: `label`, `background` (путь к картинке), `backgroundStyle` = `cover|ratio|repeat`.
- Ребро: `id`, `fromNode`, `toNode`, необязательные `fromSide`/`toSide` (`top|right|bottom|left`), `fromEnd` (по умолчанию `none`), `toEnd` (по умолчанию `arrow`), `color`, `label`.
- Цвет — hex `"#FF0000"` или пресет `"1"`–`"6"` (red, orange, yellow, green, cyan, purple). RGB пресетов **намеренно не определены**: приложение подставляет свою палитру.
- **Членство в группе только геометрическое**: явного `parent` или `children` нет. Открытые вопросы спецификации: [#57](https://github.com/obsidianmd/jsoncanvas/issues/57) — куда класть атрибуты, не вошедшие в спецификацию; [#67](https://github.com/obsidianmd/jsoncanvas/issues/67) — как строить id. Obsidian пишет 16 hex-символов, см. [sample.canvas](https://github.com/obsidianmd/jsoncanvas/blob/main/sample.canvas). Предложения [#55](https://github.com/obsidianmd/jsoncanvas/issues/55) (shape node) и [#36](https://github.com/obsidianmd/jsoncanvas/issues/36) (edge offset) не приняты ([список issues](https://github.com/obsidianmd/jsoncanvas/issues)). Рабочая группа Open Canvas пришла к мнению, что расширяемая спецификация потребует ломать 1.0 (по данным поиска: [forum 79454](https://forum.obsidian.md/t/open-canvas-working-group/79454)).
- Поведение Obsidian Canvas ([plugins/canvas](https://help.obsidian.md/plugins/canvas)):
  - text-карточку можно «Convert to file…»; файловая карточка умеет «Narrow to heading/block» (это `subpath`);
  - в канвас можно добавить карточку `.base` с закреплённым видом или перетащить целую папку;
  - `Alt`+drag дублирует выделение;
  - с 1.12 (2026-02-27) ссылки внутри canvas-файлов попадают в Backlinks и считаются связями в Graph view ([v1.12](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.12.md)).
- Obsidian Sync разрешает конфликты в canvas по правилу «last modified wins», а `.md` сливает через diff-match-patch ([sync/troubleshoot](https://help.obsidian.md/sync/troubleshoot)).
- **Прецедент расширения формата.** Плагин Advanced Canvas (v7.1.0, **GPL-3.0**) ввёл «Advanced JSON Canvas 1.0-1.0» ([spec](https://github.com/Developer-Mike/obsidian-advanced-canvas/blob/main/assets/formats/advanced-json-canvas/spec/1.0-1.0.md)), совместимый с 1.0:
  - верхний уровень `metadata {version, frontmatter, startNode}`;
  - у нод `zIndex`, `ratio`, `dynamicHeight`, `styleAttributes {}`; у групп `collapsed`; у файловых нод `portal: true` (канвас в канвасе) и `interdimensionalEdges`;
  - у рёбер `fromFloating`/`toFloating` и `styleAttributes` (path style dotted/dashed, pathfinding straight/squared/A*).
  Сохраняет ли **ядро** Obsidian Canvas чужие ключи при пересохранении файла без этого плагина — **не проверено**.
- Поддержка формата за пределами Obsidian ([apps.md](https://github.com/obsidianmd/jsoncanvas/blob/main/docs/apps.md)): Kinopio (импорт и экспорт), OrgPad, Flowchart Fun, Charkoal и другие. Есть библиотеки на TS ([@trbn/jsoncanvas](https://www.npmjs.com/package/@trbn/jsoncanvas) 1.0.6, MIT) и Rust (crate `jsoncanvas`).

### 6. Obsidian Bases

Источники: [bases](https://help.obsidian.md/bases), [bases/syntax](https://help.obsidian.md/bases/syntax), [bases/create-base](https://help.obsidian.md/bases/create-base), [bases/views/kanban](https://help.obsidian.md/bases/views/kanban), [v1.9.0](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.9.0.md), [v1.9](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.9.md), [v1.10](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.10.md).

- Bases — core plugin: insider 1.9.0 вышел 2025-05-21, публичный 1.9.10 — 2025-08-18. Это «database-like views» над файлами и их properties. Данные остаются в `.md`, а в `.base` хранится только описание представления.
- Файл `.base` — это YAML с ключами `filters` (рекурсивные `and/or/not` из строк-выражений вроде `file.hasTag("x")`, `status != "done"`), `formulas`, `properties` (`displayName`), `summaries`, `views[]` (`type`, `name`, `limit`, `groupBy`, `filters`, `order`, `summaries`). Пространства имён свойств: `note.*`, `file.*`, `formula.*`. Base также встраивается кодблоком ` ```base `.
- Layouts: Table, Cards, List (1.10), Map (официальный плагин [obsidian-maps](https://github.com/obsidianmd/obsidian-maps), MIT), **Kanban (1.14+, на 2026-10 только insider)**. Kanban группирует заметки по свойству; перенос карточки в другую колонку меняет свойство в заметке.
- **Вывод для Strata.** Импортировать нечего, кроме самого запроса. Переводить язык фильтров в запрос Strata дорого и не нужно в MVP. Зато при экспорте задач Strata как заметок с `status`/`due`/`assignees` можно генерировать `Tasks.base` с видами Table и Kanban, и пользователь Obsidian получит рабочий трекер без плагинов.

### 7. Форматы популярных плагинов

**Excalidraw** ([zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin), `manifest.json` 2.29.0 в `master` на 2026-10-13, minAppVersion 1.8.7, лицензия **AGPL-3.0**). Формат `.excalidraw.md` (по [constants.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/constants/constants.ts) и [excalidrawMarkdownParsing.ts](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/excalidrawMarkdownParsing.ts)):
~~~
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== …
# Excalidraw Data
## Text Elements
Текст элемента ^elementId
## Element Links
## Embedded Files
<fileId>: [[path/to/image.png]]
%%
## Drawing
```compressed-json
<LZString.compressToBase64(JSON сцены)>
```
%%
~~~
- Сцена: `{"type":"excalidraw","version":2,"source":…,"elements":[…],"appState":{…}}`. При отключённом сжатии блок называется ` ```json `.
- Есть секция `# Markdown Images`. Плагин читает и устаревшие чистые `.excalidraw` (JSON).
- Сжатие делает [lz-string](https://www.npmjs.com/package/lz-string) 1.5.0 (MIT). Сам [Excalidraw](https://github.com/excalidraw/excalidraw) — MIT, v0.18.1.
- Текстовые элементы и embedded files содержат обычные `[[ссылки]]`, поэтому Obsidian индексирует их как связи.

**Tasks** ([obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks), 8.5.0, **MIT**; [Tasks Emoji Format](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Reference/Task%20Formats/Tasks%20Emoji%20Format.md), [Dataview Format](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Reference/Task%20Formats/Dataview%20Format.md)):
- Даты: `➕` created, `⏳` scheduled, `🛫` start, `📅` due, `✅` done, `❌` cancelled.
- Приоритет: `⏬` lowest, `🔽` low, `🔼` medium, `⏫` high, `🔺` highest.
- `🔁 every day when done` — повтор; `🏁 keep|delete` — что делать при завершении; `🆔 abc123` и `⛔ id1,id2` — зависимости.
- Альтернативный dataview-формат: `[due:: 2023-04-16]`, `[priority:: high]`, `[repeat:: …]`, `[id:: …]`, `[dependsOn:: …]`.
- Статусы `[ ]`, `[x]`, `[-]` (cancelled), бывают и кастомные. Опциональный global filter (например `#task`) хранится в настройках плагина.
- Известная ловушка: NBSP и variation selectors ломают распознавание эмодзи.
- Зависимости `🆔/⛔` — готовые **нити между задачами**, а `📅` даёт подсветку дедлайна.

**Dataview** ([obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview), **MIT**, manifest 0.5.68, тег 0.5.70, последний коммит 2025-04-08; [add-metadata](https://github.com/blacksmithgu/obsidian-dataview/blob/master/docs/docs/annotation/add-metadata.md)):
- Inline-поля: `Key:: Value` на отдельной строке, `[key:: value]` внутри текста, `(key:: value)` со скрытым ключом в Reading mode. На задачах и пунктах списка допустим только скобочный синтаксис.
- Ключи нормализуются: `Basic Field` → `basic-field`.
- Запросы ` ```dataview ` и ` ```dataviewjs ` не переносимы, их нужно хранить как текст.
- Преемник — [Datacore](https://github.com/blacksmithgu/datacore), тег 0.1.29.

**Kanban** ([obsidian-kanban](https://github.com/mgmeyers/obsidian-kanban), 2.0.51, **GPL-3.0**; автор 2026-01-12 объявил поиск новых мейнтейнеров в [MAINTAINERS.md](https://github.com/mgmeyers/obsidian-kanban/blob/main/MAINTAINERS.md)). Формат по [common.ts](https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/common.ts) и [list.ts](https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/formats/list.ts):
- frontmatter `kanban-plugin: board`;
- колонка — `## Title` (лимит карточек кодируется в заголовке); карточка — `- [ ] text` с ` ^blockid`;
- маркер `**Complete**` в колонке, которая отмечает карточки выполненными; архив — `***` и `## Archive`;
- в конце файла `%% kanban:settings` + ` ``` ` + JSON + ` ``` ` + `%%`.
- Синтаксис дат на карточках (`@{…}`) — **не проверено**.

**Daily notes** — core plugin, конфиг в `.obsidian/daily-notes.json`. По умолчанию имя `YYYY-MM-DD`; формат moment.js может создавать подпапки (`YYYY/MMMM/YYYY-MMM-DD`). С 1.11 формат выбирается из списка, появилась настройка «Default file to open» ([daily notes](https://help.obsidian.md/plugins/daily-notes), [v1.11](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.11.md)).

### 8. Подводные камни живого зеркала

1. **Obsidian сам переписывает файлы.**
   - Frontmatter целиком при правке любого свойства (§3).
   - Все ссылающиеся файлы при переименовании внутри Obsidian (`alwaysUpdateLinks`). Одно переименование порождает лавину изменений в N файлах.
   - Мигрирует `tag`, `alias`, `cssclass`.
   - Обрабатывает «Insert template».
   - С 1.12 при удалении файла предлагает удалить его вложения ([v1.12](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.12.md)).
   - Daily notes и Templater создают файлы при старте, и Obsidian сам предупреждает, что это источник конфликтов ([sync/troubleshoot](https://help.obsidian.md/sync/troubleshoot)).
2. **Внешние переименования не распознаются.** Переименование, сделанное Strata, Obsidian увидит как «удаление + создание» и ссылки не обновит (§2). Отсюда два варианта: Strata сама переписывает обратные ссылки по правилам `app.json`, либо делегирует перенос в **Obsidian CLI** `obsidian move path=… to=…` (с 1.12, обновляет ссылки по настройкам vault, но требует запущенного Obsidian ([cli](https://help.obsidian.md/cli))).
3. **Гонка с открытым редактором.**
   - Баг-репорт на 1.13.1: при внешней записи в открытый файл «stale buffer autosaves over the file», правка теряется молча. В 1.13 есть исправление «rare race condition where a file could get stuck and fail to save», но связано ли оно с этим багом — неясно (по данным поиска: [forum 116346](https://forum.obsidian.md/t/overlapping-vault-modify-vault-process-calls-permanently-stick-file-saving/116346); [v1.13](https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.13.md)).
   - Исторические жалобы на авто-merge внешних правок: [forum 14874](https://forum.obsidian.md/t/editor-add-a-toggle-to-disable-automatic-merging-of-changes-non-obsidian-sync/14874), [discuss.logseq 2623](https://discuss.logseq.com/t/conflict-with-obsidian-content-of-a-document-erased/2623).
4. **Эхо собственных записей.** Watcher Strata увидит свои же записи. Их нужно гасить по хэшу последней записи и писать атомарно (temp + rename).
5. **Облачные синхронизаторы.**
   - iCloud на Windows «may lead to file duplication or corruption»; на macOS нужно «Keep Downloaded», иначе файлы выгружаются ([sync-notes](https://help.obsidian.md/sync-notes)). Выгруженный файл нельзя принимать за удалённый.
   - Obsidian Sync в режиме «Create conflict file» (с 1.9.7) создаёт `Name (Conflicted copy <device> YYYYMMDDHHMM).md`; canvas сливается по «last modified wins».
   - Headless Sync не рекомендуется совмещать с десктопным Sync на одном устройстве ([sync/headless](https://help.obsidian.md/sync/headless)).
6. **Dot-папки.** `.strata/` невидима для Obsidian, но Obsidian Sync её не переносит (§1). Значит, всё, что должно пережить синхронизацию Obsidian Sync, нельзя хранить только там.
7. **Канонизация YAML.** Если Strata пишет YAML в стиле, отличном от Obsidian (inline-списки, другие кавычки), то каждое открытие свойства в Obsidian даёт ложное изменение и цикл перезаписей. Нужен writer, который повторяет стиль Obsidian: блочные списки, ссылки в двойных кавычках. Сравнивать надо семантически (по распарсенному объекту), а не по тексту. Библиотека [`yaml`](https://www.npmjs.com/package/yaml) (2.9.1, ISC) через Document API позволяет менять только затронутые ключи.
8. **Имена файлов.** Имя ноды Strata — свободный текст, имя файла — нет: недопустимы `# | ^ : %% [[ ]]` и символы, запрещённые в Windows. Регистронезависимые ФС macOS и Windows против Linux. Нормализация Unicode (NFC/NFD) для кириллицы, особенно «й» и «ё», на macOS — как её обрабатывает разрешение ссылок Obsidian, **не проверено**.
9. **Переиспользование ноды** в нескольких сетях не выражается папками: у файла одно место. Перенос в Strata «домашней» сети такой ноды означает перемещение файла и переписывание ссылок.
10. **Масштаб.** «Нет лимита на число нод» означает десятки тысяч файлов под watcher. Нужен нативный рекурсивный watcher с дебаунсом и пакетной обработкой лавин от переименований. Конкретные лимиты inotify, FSEvents и ReadDirectoryChangesW в этом исследовании **не проверялись**.

### 9. Как сосуществуют другие приложения с Obsidian в одной папке

- **Foam** (VS Code, MIT, vscode@0.46.0): «You can keep using Obsidian on the same folder side-by-side. Foam doesn't change your files unless you ask it to». Wikilinks, вложения, `#^block` и frontmatter совместимы; Canvas и синтаксис Tasks не поддерживаются ([migrating-from-obsidian](https://github.com/foambubble/foam/blob/main/docs/user/recipes/migrating-from-obsidian.md)).
- **Zettlr**: работает «side by side». Свои метаданные папок (сортировка, иконка, цвет, проекты) хранит в скрытых sidecar-файлах `.ztr-directory`, и документация предупреждает, что облака иногда не синхронизируют скрытые файлы ([migrating-from-obsidian](https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/getting-started/migrating-from-obsidian.md), [migrating](https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/getting-started/migrating.md), [faq](https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/reference/faq.md)).
- **Logseq.**
  - File-графы требуют своей раскладки (`pages/`, `journals/`, `logseq/`) и блочной модели. Совместное использование с Obsidian возможно, но с компромиссами (по данным поиска: [discuss.logseq 1666](https://discuss.logseq.com/t/rename-system-folders-obsidian-compatibility/1666)).
  - DB-версия (теги 2.0.1 и 2.0.2, README: «DB version is in beta… data loss is possible») хранит граф в SQLite. Экспорт: SQLite, EDN (единственный полный формат) и «standard Markdown (no block properties)», то есть с потерями ([README](https://github.com/logseq/logseq), [db-version.md](https://github.com/logseq/docs/blob/master/db-version.md)).
  - В мае 2026 Logseq анонсировал **Markdown Mirror**: read-only проекцию DB-графа в Markdown на диске, обновляемую при редактировании. Двусторонний режим на 2026-05 был в разработке (по данным поиска: [What's New May 16 2026](https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020), [changelog](https://discuss.logseq.com/t/logseq-db-changelog/30013/37); первоисточник не открывался). Это ровно та архитектура, которую предлагаю Strata: БД как правда плюс односторонняя проекция.
- **Obsidian Headless** (npm [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless) 0.0.14, создан 2026-02-27, open beta, Node 22+, лицензия `UNLICENSED`, то есть проприетарный). Синхронизирует vault через Obsidian Sync без десктоп-приложения, режимы `bidirectional`, `pull-only`, `mirror-remote` ([headless](https://help.obsidian.md/headless), [sync/headless](https://help.obsidian.md/sync/headless)). Теоретически это мост «сервер Strata ↔ команда на Obsidian Sync», но с зависимостью от платного проприетарного сервиса.
- **Полезные открытые инструменты:**
  - [obsidian-importer](https://github.com/obsidianmd/obsidian-importer) (MIT) — эталон, как сама Obsidian генерирует ссылки при импорте.
  - [obsidian-export](https://github.com/zoni/obsidian-export) (Rust, 25.3.0, BSD-2-Clause-Patent) — разворачивает embeds и конвертирует в CommonMark, пригодится как референс для экспорта в «чистый Markdown».

## Сравнение вариантов

### Стратегии интеграции

| Вариант | Точность round-trip | Совместимость с real-time коллаборацией | Сложность | Риск потери данных | Работа «в Obsidian одновременно» |
|---|---|---|---|---|---|
| A. Разовый импорт | Высокая на входе, обратного пути нет | Полная | Низкая | Нет (vault не меняется) | Нет |
| B. Импорт + экспорт по запросу (повторный импорт со слиянием по `strata-id`) | Высокая при наличии метаданных | Полная | Средняя | Низкий | Ручной цикл |
| C. Одностороннее зеркало Strata → папка (как Logseq Markdown Mirror) | Высокая | Полная (зеркало — проекция) | Средняя | Низкий, если Obsidian только читает | Чтение в Obsidian, правка в Strata |
| D. C + приём правок текста и frontmatter `.md` из Obsidian | Средне-высокая | Хорошая (правки превращаются в CRDT-операции через 3-way diff) | Высокая | Средний | Да, кроме структуры и раскладки |
| E. Полное двустороннее зеркало, включая `.canvas` | Средняя (форматы беднее модели) | Плохая (файл не CRDT, «last write wins») | Очень высокая | Высокий | Да |
| F. Файлы как источник правды (как Obsidian) | — | Плохая (нужно сливать `.md` при одновременной правке) | Высокая | Высокий | Да |

### Где хранить метаданные Strata

| Место | Переживает переименование в Obsidian | Синхронизируется Obsidian Sync, iCloud, git | Видно и мешает в Obsidian | Подходит для |
|---|---|---|---|---|
| Frontmatter `.md` | Да (едет с файлом) | Да | Да, в панели Properties | `strata-id`, семантика ноды, ручные нити |
| `.canvas` на сеть | Ссылки внутри обновляются Obsidian при переименовании (поведение для canvas не проверено) | Да, но конфликт Sync = «last wins» | Да, и это полезно: сеть видна как Canvas | Раскладка, членство, нити, network boxes, sticky notes |
| `.strata/` (dot-папка) | Только через id-маппинг | iCloud и git — да; Obsidian Sync — **нет** | Нет | Восстановимый кэш: индекс, хэши, миниатюры |
| Видимая `_strata/` | Только через id-маппинг | Да | Да, мусор в дереве | Не рекомендуется |

### Маппинг Obsidian ↔ Strata

| Obsidian | Strata | Импорт | Экспорт и зеркало | Потери |
|---|---|---|---|---|
| `.md`-файл | Нода kind=`text` (по умолчанию) | Тело хранится **как есть** (raw Markdown), заголовок = имя файла | `.md` в папке «домашней» сети | Нет, если редактор Strata не нормализует Markdown |
| `.md` только из задач `- [ ]` (или с `strata-kind: checklist`) | kind=`checklist` | По флагу или эвристике (настраивается) | `.md` со списком задач, поля Tasks сохраняются | Нет |
| Папка | Сеть (`network`) — начальное дерево и путь `/a/b/c` для path bar | Папка → сеть, файлы → ноды внутри; раскладка через auto layout (L) | Папка = «домашняя» сеть ноды | Множественные размещения папками не выражаются |
| `.canvas` | Сеть с раскладкой (по умолчанию) **или** доска | file-нода → **размещение** существующей ноды (переиспользование), text → sticky note, link → URL-нода, group → network box (членство по геометрии), edge → нить | Один `.canvas` на каждую сеть, рядом с папкой сети | Точки на нитях, флаги, форма, стиль нити — в расширенных ключах `strata`, с риском, что Obsidian их сотрёт |
| file-нода canvas на `.canvas` | Вложенная сеть (dive in / go up) | Ссылка на дочерний канвас = подсеть | Вложенная сеть = file-нода на её `.canvas` | — |
| Frontmatter | Атрибуты ноды (типизированные) | Типы из `types.json`, иначе вывод по значению; `tag/alias/cssclass` → синонимы | Пишем блочный YAML в стиле Obsidian | Комментарии YAML Obsidian всё равно может удалить |
| `tags`, `#tag`, `#a/b` | Теги, иерархические | Регистронезависимо, сохраняется первое написание | `tags:` в frontmatter | — |
| `aliases` | Альтернативные имена (участвуют в нечётком поиске) | 1:1 | 1:1 | — |
| `[[wikilink]]` и Markdown-ссылка в тексте | Нить, производная от текста | Разрешение по правилам Obsidian; неоднозначные и битые — в отчёт; битые → «ноды-призраки» (полупрозрачные баблы) | Остаётся в тексте; формат по `useMarkdownLinks`/`newLinkFormat` | — |
| `#Heading`, `#^block` | Нить с якорем (`subpath`) | Якорь хранится на нити | 1:1 | — |
| `![[note]]` (embed) | Нить с признаком «встраивание» (не тип ребра, а атрибут) | 1:1 | 1:1 | — |
| Ссылки в свойствах (`"[[X]]"`) | Ручные нити | Свойство `strata-inputs` → входы ноды, прочие свойства-ссылки → нити плюс атрибут | Ручные нити без текста пишутся в `strata-inputs` | Порядок входов сохраняется списком |
| Вложения (img, pdf, audio, video) | Медиа-ноды | Файл остаётся на месте, нода ссылается на путь | В папку по `attachmentFolderPath` | — |
| `![[img.png\|300]]` | Размер отображения | Атрибут размещения | 1:1 | — |
| `.excalidraw.md` | Доска (`board`) | Распаковка LZString → сцена Excalidraw → элементы доски; `[[ссылки]]` → нити | Если движок досок совместим с Excalidraw (см. R5) → `.excalidraw.md`, иначе `.canvas` + PNG/SVG-превью | Зависит от движка |
| Kanban `.md` (`kanban-plugin: board`) | Доска с колонками-виджетами или сеть задач | Колонки → группы, карточки → чек-лист-элементы или ноды-задачи (выбор при импорте) | Не экспортируем в формат Kanban-плагина (GPL, не поддерживается) — вместо этого `.base` Kanban | Настройки плагина |
| Tasks (`📅 ⏳ 🔁 🆔 ⛔`…) | Атрибуты задач, дедлайн-подсветка; `🆔/⛔` → нити зависимостей | Парсинг эмодзи и dataview-формата | Текст не трогаем, атрибуты синхронизируем обратно в эмодзи | — |
| Dataview `key:: value` | Атрибуты (страничные или пунктовые) | Только чтение, текст не меняем | Как есть | Запросы `dataview` — просто текст |
| `.base` | «Сохранённый вид» (не MVP) | Файл сохраняется как есть, не исполняется | Генерируем `Tasks.base` для задач | Фильтры не переносим |
| Daily notes | Журнал или дневные ноды (если будет E5) | Читаем `daily-notes.json`: папка и формат | По тем же настройкам | — |
| `.obsidian/` | — | Только чтение | Никогда не пишем | — |

## Рекомендация для Strata

**1. Источник правды — хранилище Strata, а не папка `.md`.** Обоснование:
- real-time коллаборация обязательна, а файл не сливается конкурентно (Obsidian Sync сама сливает `.md` через diff-match-patch с риском дублей, а canvas — «last wins»);
- одна нода живёт в нескольких местах, а у файла одно место;
- нити бывают без текста, есть доски, координаты и флаги, которые Markdown не выражает;
- требуется ленивая загрузка контента при «неограниченном» числе нод.
Одновременная работа в Obsidian — nice-to-have, поэтому архитектура не должна ей подчиняться.

**2. Этапы.**
- **MVP: импорт vault (вариант A/B).** Сканирование → парсинг (CommonMark/GFM + OFM-расширения: wikilink, embed, `^id`, `%%`, callout, `==`) → разрешение ссылок по правилам Obsidian. Порядок: путь от корня → относительный путь → уникальный basename; при неоднозначности берётся кандидат с самым коротким путём, а ссылка помечается → создание нод и нитей → auto layout (L) на каждую сеть → **отчёт об импорте**: битые ссылки стали «призраками», есть неоднозначные ссылки, неподдержанный синтаксис плагинов, переименованные из-за недопустимых символов файлы. При разовом импорте vault **не модифицируется**. Соответствие «путь → id» хранится в Strata, поэтому повторный импорт сливается, а не дублирует.
  - Плагины в MVP: Tasks (эмодзи) и Excalidraw (только чтение). Сразу после MVP: Dataview inline (атрибуты), Kanban, Canvas → сеть или доска. Bases сохраняются как файлы.
- **MVP+: экспорт по запросу** в чистую папку-vault (B). Структура: файлы, frontmatter, `.canvas` на сеть, при необходимости `Tasks.base`.
- **Фаза 2: зеркало C → D.** Strata пишет проекцию в выбранную папку и принимает обратно только **текст тела и frontmatter `.md` текстовых и чек-лист нод**. Входящая правка превращается в CRDT-операцию через 3-way diff относительно последнего записанного снапшота. Хэш снапшота лежит в `.strata/` — это кэш; без него Strata откатывается к режиму «Obsidian победил, старое уходит в историю». Структура (сети, раскладка, ручные нити) принадлежит Strata. Правки `.canvas` из Obsidian принимаются по принципу best-effort: координаты и добавленные file-ноды — да, удаление нод — только с подтверждением.
- **Вариант E (полное двустороннее, включая canvas) не делать.**

**3. Метаданные для round-trip** (что пишет Strata).

Frontmatter — минимально и с префиксом, чтобы не конфликтовать с пользовательскими свойствами. Комментарии в примере только поясняют; Strata их не пишет, Obsidian их всё равно удалит:
```yaml
---
strata-id: 01JA7Q3V9K2M8X4T6R1B5C0D2E   # ULID, обязателен в режиме зеркала/экспорта
strata-kind: checklist                  # только если вид не выводится из файла
strata-icon: preset/anchor              # опционально: визуал ноды (не размещения)
strata-inputs:                          # ручные нити без текста; порядок = порядок входов (как merge в Houdini)
  - "[[Спецификация]]"
  - "[[Референсы/Шрифты]]"
status: in-progress                     # доменные атрибуты — обычные свойства без префикса,
due: 2026-11-01                         # чтобы работали Bases/Dataview/Tasks
assignees:
  - "[[Иван]]"
tags:
  - project/alpha
---
```
Почему так:
- id во frontmatter переживает переименования и любые синхронизаторы. По нему watcher распознаёт переименование, которое выглядит как «удаление + создание».
- Нити в `strata-inputs` — это ссылки в свойствах. Obsidian покажет их в Backlinks (с 1.4.4), а при переименовании внутри Obsidian сам их обновит (1.5.7 и далее).
- Нить хранится **один раз, на нижней по течению ноде**, как входы в Houdini. Это исключает рассинхрон двух концов.

`.canvas` на каждую сеть — это раскладка и размещения. Каждое размещение ноды в сети — file-нода со своим id (id размещения ≠ id ноды). Плюс группы (network boxes), text-ноды (sticky notes), link-ноды и рёбра между размещениями. Bubble size → `width/height`; координаты округляются до целых по спецификации. Цвет: пресет `"3"` (yellow) для акцентной «жёлтой подсветки» из дизайна, остальное — hex. Расширения Strata (точки на нитях, linear/bezier, флаги, форма) кладутся в один ключ `"strata": {…}` на ноде или ребре по прецеденту Advanced Canvas. Поскольку сохранение чужих ключей ядром Obsidian **не проверено**, их копия держится в `.strata/` с ключом «id канваса + id ноды» и восстанавливается при потере.

`.strata/` — только восстановимое: индекс поиска, миниатюры, хэши для 3-way merge, кэш расширений канвасов. Ничего незаменимого: Obsidian Sync эту папку не переносит.

**4. Правила записи при зеркале** (обязательные):
- никогда не трогать `.obsidian/`, `.trash/`, файлы из `userIgnoreFilters` и конфликтные копии;
- писать только при семантическом изменении; атомарная запись; подавление эха по хэшу; дебаунс и пакетная обработка лавин;
- YAML-writer в стиле Obsidian с правкой только изменённых ключей;
- ссылки генерировать по `useMarkdownLinks`/`newLinkFormat`;
- переименования от Strata: сначала переписать обратные ссылки в одной транзакции, затем переименовать файл. Опционально, если Obsidian запущен, делегировать `obsidian move`;
- имена файлов санитизировать, настоящее имя ноды хранить в `aliases` (оно так и будет участвовать в поиске) или в `title`;
- в командном режиме зеркало ведёт **один** владелец: один клиент или сервер, экспортирующий в git. Несколько клиентов, каждый со своим зеркалом в общую Dropbox или Sync-папку, исключаются: это двойная синхронизация и петли.

**5. Тестовый корпус.**
- Синтетический vault: дубли имён, кириллица (NFC и NFD), все виды ссылок и embed, Tasks, Dataview, Kanban, Excalidraw (сжатый и несжатый), canvas с группами, Bases.
- Плюс локально (не в репозиторий: лицензия не указана) справка Obsidian из obsidian-help: 179 `.md` в `en/` и 179 в `ru/`.
- Критерий: «импорт → экспорт → diff» даёт нулевой текстовый diff для тел `.md`.

## Риски

- **Нормализация Markdown редактором Strata.** Если WYSIWYG-редактор (выбор в R4) переписывает Markdown (экранирование, списки, `^id`, `%%`, callouts, dataview-поля), обещание «без потерь» рушится на первом сохранении. Нужен редактор с сохранением исходного текста или режим «неизвестный синтаксис как сырые фрагменты».
- **Пинг-понг с Obsidian из-за frontmatter.** Obsidian переписывает YAML целиком, и без семантического сравнения и совпадающего стиля сериализации начнутся бесконечные перезаписи и шум в истории.
- **Потеря правок при одновременном редактировании одного файла**: свежий баг-репорт на 1.13.1. Зеркало должно предупреждать и не писать в файлы с недавней внешней активностью.
- **Неоднозначность разрешения ссылок** при одинаковых именах. Импорт может связать «не тот» файл; нужен отчёт и ручное исправление.
- **Canvas под Obsidian Sync** конфликтует по «last wins». Раскладка, одновременно изменённая в Strata и Obsidian, теряется целиком.
- **Расширенные ключи в `.canvas`** может стереть Obsidian (не проверено), а `.strata/` не едет через Obsidian Sync. Визуальные детали (точки, флаги) могут теряться у пользователей Obsidian Sync.
- **Лицензии.** Excalidraw-плагин — AGPL-3.0, Kanban и Advanced Canvas — GPL-3.0. Копировать их код в Strata нельзя, если её лицензия не совместима; парсеры пишем сами по формату. Excalidraw core, lz-string, Tasks, Dataview, JSON Canvas, obsidian-importer — MIT.
- **Дрейф форматов.** Obsidian выпускает минорную версию раз в 2–5 месяцев (1.9 — 2025-08, 1.10 — 2025-11, 1.11 — 2026-01, 1.12 — 2026-02, 1.13 — 2026-07, 1.14 в insider с 2026-09): 1.11 изменила ссылки в свойствах, 1.12 — canvas-backlinks, 1.14 добавила цветные highlights `==🔵…==`. Плагины тоже меняются (у Kanban нет мейнтейнера, Dataview фактически заморожен). Нужен регулярный прогон тестового корпуса.
- **Масштаб.** Watcher и полный реиндекс на десятках тысяч файлов при лавинах от переименований могут дать заметную нагрузку. Нужен инкрементальный индекс.
- **Семантика направления нитей из wikilinks.** Если каждая текстовая ссылка строит иерархию mind-map, реальный vault с тысячами ссылок даст «кашу», а не дерево (см. открытые вопросы).

## Открытые вопросы

1. Как вы будете жить с Obsidian после перехода: продолжите ежедневно работать в нём на той же папке (тогда зеркало D нужно рано) или переедете один раз (хватит импорта и экспорта)?
2. Допустимо ли, что Strata в режиме зеркала или экспорта пишет в заметки `strata-id` и другие `strata-*` свойства? В Obsidian они будут видны в панели Properties.
3. Направление и вес нитей из `[[ссылок]]`: ссылка из текста A на B делает B «дочерней» A в иерархии mind-map или это «мягкая» связь, которая рисуется, но иерархию не строит? Можно ли различать нити «из текста» и «нарисованные вручную» как происхождение, а не как тип ребра?
4. При импорте папки становятся сетями всегда или это выбор пользователя (сети / теги / игнорировать)? Что делать с канвасами: импортировать как сеть с раскладкой или как доску?
5. Какими плагинами Obsidian вы реально пользуетесь (Excalidraw, Tasks, Dataview, Kanban, Templater, Bases, Advanced Canvas)? От этого зависит приоритет парсеров.
6. Нужна ли совместимость с Obsidian для командных пространств (зеркало на сервере, экспорт в git) или только в соло-режиме?
7. Как синхронизируется ваш текущий vault (Obsidian Sync, iCloud, git, Syncthing)? От этого зависят риски зеркала.
8. Нужен ли экспорт досок в формат Excalidraw-плагина? Это влияет на выбор движка досок в R5.
9. Если имя ноды содержит символы, недопустимые в имени файла: санитизировать имя файла и хранить настоящее имя в `aliases` или в `title`?
10. Генерировать ли при экспорте `.base`-файлы (например, канбан задач по `status`) для тех, кто остаётся в Obsidian?

## Источники

Obsidian, справка (исходники: https://github.com/obsidianmd/obsidian-help, коммит 08ef563, 2026-10-11):
- https://help.obsidian.md/links
- https://help.obsidian.md/embeds
- https://help.obsidian.md/aliases
- https://help.obsidian.md/properties
- https://help.obsidian.md/tags
- https://help.obsidian.md/settings
- https://help.obsidian.md/configuration-folder
- https://help.obsidian.md/data-storage
- https://help.obsidian.md/file-formats
- https://help.obsidian.md/attachments
- https://help.obsidian.md/symlinks
- https://help.obsidian.md/obsidian-flavored-markdown
- https://help.obsidian.md/plugins/canvas
- https://help.obsidian.md/plugins/graph
- https://help.obsidian.md/plugins/daily-notes
- https://help.obsidian.md/bases
- https://help.obsidian.md/bases/syntax
- https://help.obsidian.md/bases/create-base
- https://help.obsidian.md/bases/views/kanban
- https://help.obsidian.md/cli
- https://help.obsidian.md/headless
- https://help.obsidian.md/sync/headless
- https://help.obsidian.md/sync/troubleshoot
- https://help.obsidian.md/sync-notes

Obsidian, release notes:
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.0.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.4.4.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.5.7.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.6.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.9.0.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.9.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.10.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.11.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.12.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.13.md
- https://github.com/obsidianmd/obsidian-help/blob/master/Release%20notes/v1.14.md

Obsidian, API и инструменты:
- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- https://github.com/obsidianmd/obsidian-importer/blob/master/web/obsidian/vault.ts
- https://github.com/obsidianmd/obsidian-maps
- https://www.npmjs.com/package/obsidian-headless

Конфиги `.obsidian/` на GitHub:
- https://github.com/search?q=filename%3Aapp.json+newLinkFormat+attachmentFolderPath&type=code
- https://github.com/search?q=path%3A.obsidian+filename%3Atypes.json+multitext&type=code
- https://github.com/search?q=filename%3Adaily-notes.json+path%3A.obsidian&type=code

JSON Canvas:
- https://jsoncanvas.org/spec/1.0/
- https://github.com/obsidianmd/jsoncanvas
- https://github.com/obsidianmd/jsoncanvas/blob/main/spec/1.0.md
- https://github.com/obsidianmd/jsoncanvas/blob/main/sample.canvas
- https://github.com/obsidianmd/jsoncanvas/blob/main/docs/apps.md
- https://github.com/obsidianmd/jsoncanvas/issues
- https://github.com/obsidianmd/jsoncanvas/issues/57
- https://github.com/obsidianmd/jsoncanvas/issues/67
- https://github.com/obsidianmd/jsoncanvas/issues/55
- https://github.com/obsidianmd/jsoncanvas/issues/36
- https://obsidian.md/blog/json-canvas/
- https://forum.obsidian.md/t/open-canvas-working-group/79454
- https://github.com/Developer-Mike/obsidian-advanced-canvas
- https://github.com/Developer-Mike/obsidian-advanced-canvas/blob/main/assets/formats/advanced-json-canvas/spec/1.0-1.0.md
- https://www.npmjs.com/package/@trbn/jsoncanvas

Плагины:
- https://github.com/zsviczian/obsidian-excalidraw-plugin
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/constants/constants.ts
- https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/master/src/shared/excalidrawMarkdownParsing.ts
- https://github.com/excalidraw/excalidraw
- https://www.npmjs.com/package/lz-string
- https://github.com/obsidian-tasks-group/obsidian-tasks
- https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Reference/Task%20Formats/Tasks%20Emoji%20Format.md
- https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Reference/Task%20Formats/Dataview%20Format.md
- https://github.com/blacksmithgu/obsidian-dataview
- https://github.com/blacksmithgu/obsidian-dataview/blob/master/docs/docs/annotation/add-metadata.md
- https://github.com/blacksmithgu/datacore
- https://github.com/mgmeyers/obsidian-kanban
- https://github.com/mgmeyers/obsidian-kanban/blob/main/MAINTAINERS.md
- https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/common.ts
- https://github.com/mgmeyers/obsidian-kanban/blob/main/src/parsers/formats/list.ts

Форум Obsidian (по данным поиска, страницы напрямую не открывались):
- https://forum.obsidian.md/t/yaml-properties-api-processfrontmatter-removes-alters-string-quotes-comments-types-formatting/65851
- https://forum.obsidian.md/t/bug-using-the-properties-menu-deletes-yaml-comments-from-the-frontmatter/69048
- https://www.obsidianstats.com/plugins/preserve-frontmatter-formatting
- https://forum.obsidian.md/t/will-externally-renamed-files-lose-all-backlinks-do-settings-matter/40004
- https://forum.obsidian.md/t/auto-updated-links-rename-from-file-system/25682
- https://desktopcommander.app/blog/obsidian-bulk-rename-files/
- https://forum.obsidian.md/t/overlapping-vault-modify-vault-process-calls-permanently-stick-file-saving/116346
- https://forum.obsidian.md/t/editor-add-a-toggle-to-disable-automatic-merging-of-changes-non-obsidian-sync/14874
- https://forum.obsidian.md/t/disambiguiting-mutiple-files-with-the-same-name/32110
- https://forum.obsidian.md/t/frontmatter-link-in-the-graph/39851
- https://forum.obsidian.md/t/enable-use-access-to-hidden-files-and-folders-starting-with-a-dot-dotfiles-dotfolders-within-obsidian/26908
- https://forum.obsidian.md/t/obsidian-sync-sync-hidden-files-and-folders-as-well-start-with-a-dot/32123

Другие приложения:
- https://github.com/foambubble/foam/blob/main/docs/user/recipes/migrating-from-obsidian.md
- https://github.com/foambubble/foam/blob/main/docs/user/features/wikilinks.md
- https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/getting-started/migrating-from-obsidian.md
- https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/getting-started/migrating.md
- https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/reference/faq.md
- https://github.com/logseq/logseq
- https://github.com/logseq/docs/blob/master/db-version.md
- https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020
- https://discuss.logseq.com/t/logseq-db-changelog/30013/37
- https://discuss.logseq.com/t/rename-system-folders-obsidian-compatibility/1666
- https://discuss.logseq.com/t/conflict-with-obsidian-content-of-a-document-erased/2623
- https://github.com/zoni/obsidian-export
- https://www.npmjs.com/package/yaml
