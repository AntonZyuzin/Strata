# R8. Конкуренты: что Strata берёт и чего избегает

> Дата исследования: 2026-10-13. Версии и даты релизов сверены по тегам Git (коммит тега), лицензии — по файлам `LICENSE` в репозиториях проектов.
>
> **Ограничение доступа.** Из среды исследования открывались только GitHub (код, документация в репозиториях, issues) и поисковая выдача. Сайты heptabase.com, anytype.io, affine.pro, thebrain.com, tana.inc, capacities.io, forum.obsidian.md, Reddit и Hacker News напрямую не открывались: прокси отвечал 403, поиск по reddit.com запрещён. Поэтому:
> - факты об Anytype, AFFiNE, Logseq, Plane и Obsidian взяты из первоисточников на GitHub (документация лежит там же);
> - факты о Heptabase, TheBrain, Tana, Capacities, InfraNodus, Miro и других закрытых продуктах — из выдержек поиска со ссылкой на страницу-первоисточник. Такие места помечены «(по выдержке поиска)»;
> - жалобы пользователей собраны с официальных форумов, из GitHub issues и пересказов HN, а не с Reddit. Выборка смещена к тем, кто остался и просит доработок.

## Кратко

- **Связку Strata не закрывает никто.** Нужен граф-первый интерфейс с вложенными сетями, задачами, self-hosted сервером без лимита мест и OSI-лицензией. У Heptabase нет self-host, код закрыт. У AFFiNE сервер под Enterprise-лицензией, бесплатно — 10 мест на пространство. Anytype не open source (Any Source Available License 1.0). TheBrain закрыт. Plane и Logseq открыты (AGPL-3.0), но Plane — это трекер без графа, а Logseq — аутлайнер без холста. Ниша свободна.
- **«Одна сущность — много мест» решена у всех одинаково, и это подтверждает модель Strata.** Карточка Heptabase живёт в Card Library и лежит на многих досках. Объект Anytype входит во многие Collections: там есть отдельные команды `Unlink from Collection` и `Move to Bin`, а осиротевшее Anytype собирает в «Cleanup». У ноды Tana один Owner («дом») и много Parents. У мысли TheBrain может быть несколько родителей. **2026-10-02** Anytype добавил дерево «created-in»: объект показывается под тем объектом, где был создан, пока тот на него ссылается. Это ровно «основное размещение» Strata.
- **Вложенные холсты у конкурентов мелкие и тормозят.** Heptabase советует два уровня досок и замечает лаги уже с **100–150 карточек** на доске (по выдержке поиска). У Miro замедление начинается с ~1 000 объектов, рекомендовано до 5 000. Вложенный canvas в Obsidian — просто ссылка без превью. Logseq в DB-версии **убрал whiteboards совсем**. Строки пути в духе Houdini ни у кого не нашлось. Глубокая навигация с путём и быстрый холст — главное отличие Strata.
- **Задачи в базах знаний — «список с датами».** В Heptabase есть дедлайны и группы Today/Upcoming/Overdue, но не найдено напоминаний. Повторяющиеся задачи в Anytype просят годами. Capacities — только для одного пользователя. Трекеры (Plane, Linear) графа не имеют. Работают «задачи как теги/атрибуты + таблица/канбан-запрос»: Logseq `#Task`, Obsidian Bases с Kanban в 1.14, Anytype Queries. Свёрток прогресса по вложенности в PKM-инструментах не найдено.
- **Граф полезен, когда он локальный, отфильтрованный и стабильный.** На форуме Obsidian глобальный граф называют «красивым, но почти бесполезным»: много данных, мало информации. Полезными признают локальный граф, фильтры и группы. Пользователи Anytype в 2026 году просят локальный граф в сайдбаре (#2203) и сохранение позиций узлов (#2142). Ценность InfraNodus — в метриках: сообщества по модулярности и «структурные пробелы». Исследования 2D/3D: 2D быстрее для обзора, 3D требует больше навигации.
- **Self-host у конкурентов — главный источник боли.** AFFiNE: 10 мест бесплатно, дальше — платный «self-hosted team plan», хотя README обещает «unrestricted version». Anytype: 8 сервисов, compose «для личного использования», миграция MinIO → Garage ломала установки. Plane CE: 13 сервисов, минимум 4 ГБ ОЗУ. Sync в Logseq DB — платная alpha по приглашениям. AFFiNE закрыл issue о молча упавшей синхронизации и потере данных как «not planned».
- **MCP — уже гигиена, а не отличие.** MCP-серверы есть у Heptabase (с 2025-12), Anytype (`anytype-mcp`, MIT), Logseq DB, Miro (с 2026-02) и Tana. Отличие Strata — графовые операции, предпросмотр и откат правок агента (см. [R6](R6-mcp-ai.md)).
- **Код несвободных конкурентов брать нельзя.** Anytype — ASAL 1.0: коммерческое использование только в «Allowed Networks». InfraNodus — SPUL: запрещены коммерция и SaaS. Kinopio — PolyForm Noncommercial. Бэкенд AFFiNE — EE. Свободны any-sync (MIT), клиент AFFiNE (MIT), Plane и Logseq (AGPL-3.0).

## Находки

### 1. Сводка статусов на 2026-10

| Продукт | Модель | Версия / дата | Лицензия (проверено) | Self-host | Совместная работа в реальном времени | Цена |
|---|---|---|---|---|---|---|
| Heptabase | Карточки в общей библиотеке, вложенные доски | Дорожная карта до 2026-03-31; MCP — v1.81.2 от 2025-12-11 (по выдержке поиска) | Закрытый код | Нет | Да, шаринг досок по email | Pro $11.99/мес или $107.88/год, Premium $23.99/$215.88; бесплатного плана нет, триал 7 дней (по выдержке поиска) |
| Anytype | Объекты, типы, свойства, Queries/Collections, граф | `anytype-ts` v0.57.4, 2026-10-03 | Клиент и `anytype-heart` — Any Source Available License 1.0; `any-sync*` — MIT | Да, any-sync (8 сервисов) | Да, E2E, local-first | Free + платные; Business €20/редактор/мес |
| AFFiNE | Документ ⇄ edgeless-холст на одном doc, BlockSuite, Yjs | v0.27.4 (тег 2026-08-17); canary v2026.10.12 | MIT, кроме `packages/backend` и `packages/common/native` (Enterprise Edition License) | Да, 4 контейнера | Да | Self-host бесплатно до 10 мест, далее $10/место/мес (по выдержке поиска) |
| Logseq | Аутлайнер; DB-версия: ноды, теги-классы | 2.0.2 (DB beta), 2026-10-07; 0.10.15 (файловая), 2025-12-01 | AGPL-3.0 | Sync — да (alpha) | RTC alpha, по приглашениям, платно | — |
| Tana | Ноды, ссылки, supertags | — | Закрытый код | Нет (не найдено) | Да (облако) | Free, Pro, Max; цифры расходятся (по выдержке поиска) |
| Capacities | Объекты с типами | — | Закрытый код | Нет | **Нет**, только для одного пользователя | Free + Pro (цифры расходятся) |
| TheBrain | Plex: мысли с несколькими родителями | TheBrain 15 (веб — 2025-12, Linux beta — 2026-05) | Закрытый код | Нет (не найдено) | TeamBrain $25/место/мес | Free для личного использования; Pro $219 разово (по выдержке поиска) |
| Obsidian Canvas / Graph / Bases | Файлы `.md`, `.canvas` (JSON Canvas) | Bases Kanban — с Obsidian 1.14 | Закрытый код (формат открыт) | — | Нет (Sync — не совместное редактирование) | Бесплатно |
| InfraNodus | Текст → сеть, сообщества, пробелы, 3D | Облако + плагин Obsidian | Открытая старая версия — SPUL (некоммерческая, без SaaS) | Только старая версия на Neo4j 3.x | — | Облако от ~€9–12/мес (по выдержке поиска) |
| Kinopio | Карточки на пространствах, «живые» связи | `kinopio-client` (см. [R1](R1-houdini-kinopio-ux.md)) | PolyForm Noncommercial 1.0.0 | Нет | Да | 100 карточек бесплатно, $8/мес (по выдержке поиска; данные расходятся) |
| Plane | Трекер: issues, cycles, modules, pages | v1.4.2, 2026-08-23 | CE — AGPL-3.0; Commercial — закрытый | Да, 13 сервисов | Да | CE без лимитов; Commercial — 12 бесплатных мест (документация) |
| Linear | Трекер, keyboard-first | — | Закрытый код | **Нет**, только облако (по выдержке поиска) | Да | Free до 250 issues; Basic $10, Business $16 за место (по выдержке поиска) |

Источники по строкам — в разделах ниже.

### 2. Heptabase

**Модель.** Карточки не принадлежат доскам. Все карточки лежат в **Card Library**, а доска хранит лишь размещения. Одна карточка может быть на нескольких досках одновременно, список досок виден в разделе Info карточки ([fundamental-elements](https://wiki.heptabase.com/fundamental-elements), по выдержке поиска). Позже появилась панель «whiteboard location» в правом сайдбаре: все доски, где лежит карточка, с переходом к ним ([newsletters](https://wiki.heptabase.com/newsletters), по выдержке поиска; дата не видна).

**Удаление.** Удалённые карточки и доски попадают в Trash, оттуда их можно восстановить. После окончательного удаления они не восстанавливаются даже из истории версий ([support](https://support.heptabase.com/en/articles/10447264-how-to-restore-deleted-cards-and-whiteboards-from-trash)). Удаление карточки — действие уровня библиотеки, то есть она исчезает со всех досок. То, что «убрать с доски» оставляет карточку в библиотеке, следует из модели, но формулировку из документации получить не удалось (**не проверено**).

**Вложенность и навигация.** Доски работают как папки, под-доска создаётся ПКМ по пустому месту. Официальный совет: **два уровня** (родительские доски и под-доски), третий уровень — только когда на доске второго уровня больше 100 карточек, а до этого использовать Sections ([nested-whiteboard](https://wiki.heptabase.com/nested-whiteboard), [organize-knowledge-and-projects](https://wiki.heptabase.com/organize-knowledge-and-projects), по выдержке поиска). Задокументированной строки пути не нашлось. Для перехода между досками есть список всех досок и под-досок при наведении на приложение Map в левом сайдбаре (по выдержке поиска). Права доступа наследуются: шаринг доски включает её под-доски ([collaborate](https://wiki.heptabase.com/collaborate-and-discuss-with-others)).

**Производительность.** Собственная статья поддержки: заметные лаги начинаются примерно со **100–150 карточек на доске** и растут с их числом. Даже меньше 100 карточек тормозят, если на доске много картинок, видео, больших текстов, кода, формул или крупных mind map. Отдельно тормозят карточки, связанные с более чем 100 другими. Крупный импорт из Notion или Obsidian бьёт по производительности и синхронизации. Совет — разносить содержимое по под-доскам: «производительность досок независима» ([support 11430704](https://support.heptabase.com/en/articles/11430704-troubleshooting-performance-and-lag-issues-in-heptabase), по выдержке поиска).

**Задачи.** С 2023-11 задачи можно создавать где угодно и ставить им срок. Они группируются в Today / Upcoming / Overdue / No due date ([newsletter 2023-11-30](https://wiki.heptabase.com/newsletters/2023-11-30)). Позже задачи появились в мобильном приложении (свайпы «выполнено / перенести»). Напоминаний и уведомлений в найденных материалах нет. Таблица и канбан по тегам и свойствам есть с версии 1.0 ([version-one](https://wiki.heptabase.com/version-one)). В 2026-01 переделана база тегов, добавлены вложенные теги (v1.83.0) ([roadmap](https://wiki.heptabase.com/roadmap)).

**Данные и AI.** На одном устройстве данные хранятся в локальной базе. При синхронизации они дублируются в AWS (us-west-1, AES-256 at rest, ключ у AWS) ([data-safety](https://wiki.heptabase.com/data-safety)). Есть полный экспорт в Markdown и обещание открыть код, если компания закроется ([support 10364279](https://support.heptabase.com/en/articles/10364279-how-sustainable-is-heptabase-can-i-easily-export-my-data-and-move-on)). MCP вышел в v1.81.2 (2025-12-11): чтение, поиск и запись карточек и журналов из Claude и ChatGPT ([roadmap](https://wiki.heptabase.com/roadmap), [support 12679581](https://support.heptabase.com/en/articles/12679581)).

**Совместная работа.** Доска шарится по email. Приглашённым не нужна подписка. Есть уровни доступа, включая «Can View» и «Can Chat» ([collaborate](https://wiki.heptabase.com/collaborate-and-discuss-with-others), по выдержке поиска). Self-host нет.

**Жалобы.** Прямых тредов Reddit получить не удалось. Косвенно: продукт только платный, а лимит производительности на доске признаёт сам вендор. В AMA 2024-11 CEO перечислил самые просимые функции: несколько окон, правый сайдбар, экспорт в PDF, несколько открытых досок, быстрый захват ([ama-2024-11](https://wiki.heptabase.com/ama-2024-11)).

**Что взять:** библиотеку как источник правды и доску как набор размещений; панель «где ещё лежит»; Sections внутри холста как альтернативу лишней вложенности. **Чего избегать:** потолка в 100–150 объектов на холст и закрытого облака.

### 3. Anytype

**Лицензия.** `anytype-ts` и `anytype-heart` распространяются под **Any Source Available License 1.0**. Использование, изменение и распространение разрешены только (a) для Non-Commercial Use или (b) для коммерческого использования в «Allowed Networks». Allowed Networks — сети, явно одобренные Any Association (`networks.any.coop`); ассоциация может добавлять сети в список и убирать их ([LICENSE.md](https://github.com/anyproto/anytype-ts/blob/main/LICENSE.md)). Подпадает ли собственная self-hosted сеть компании под коммерческое использование, из текста неясно; на форумах это трактуют по-разному ([privacyguides](https://discuss.privacyguides.net/t/question-about-notion-foss-alternative-anytype/19191), **юридически не проверено**). Протокол `any-sync` и узлы `any-sync-node`, `-coordinator`, `-filenode`, `-consensusnode`, `-dockercompose`, `-tools` — под MIT ([any-sync LICENSE](https://github.com/anyproto/any-sync/blob/main/LICENSE.md)). Сайт isitreallyfoss классифицирует Anytype как не-FOSS ([isitreallyfoss](https://isitreallyfoss.com/projects/anytype)); на запуске 2023 года критика в HN сводилась к тому же, это видно по пересказу треда ([outlinersoftware](https://outlinersoftware.com/topics/viewt/9794/10)).

**Модель «одна сущность — много мест»** (документация в репозитории [anyproto/docs](https://github.com/anyproto/docs), коммит от 2026-10-12):
- «Everything exists as its own independent Object». Папок нет. Блок в документе — только ссылка на объект: удалили блок — объект остался ([deletion.md](https://github.com/anyproto/docs/blob/main/organize/deletion.md)).
- **Collection** — ручной набор, «ближе всего к папке». Объект может быть во многих коллекциях. В меню две разные команды: **Unlink from Collection** (убрать из коллекции, объект остаётся) и **Move to Bin** («удаляет объект из всех коллекций и всего пространства», с возможностью восстановления). Удаление самой коллекции объекты не трогает ([collections.md](https://github.com/anyproto/docs/blob/main/organize/collections.md)).
- **Query** — живой фильтр по типу или свойству, хранилищем не является. Типы — «встроенные Queries» ([queries.md](https://github.com/anyproto/docs/blob/main/organize/queries.md)).
- **Bin** хранит объекты бессрочно, пока их не удалят навсегда. Восстановление возвращает связи и настройки ([deletion.md](https://github.com/anyproto/docs/blob/main/organize/deletion.md)).
- **Cleanup** — плата за эту модель. Документация прямо пишет, что удаление «труднее понять», а пространство «раздувается» неудалёнными объектами. Cleanup предлагает к удалению два вида «сирот»: (1) объект, созданный внутри родителя и больше нигде не связанный, после удаления родителя; (2) такой же объект после того, как его ссылку убрали из родителя ([deletion.md](https://github.com/anyproto/docs/blob/main/organize/deletion.md)).
- **Дерево «created-in»** (PR [#2396](https://github.com/anyproto/anytype-ts/pull/2396), влит 2026-10-02). В сайдбаре появилась секция Tree: «каждый объект вложен в объект, в котором он создан (`createdInContext`)», но только пока родитель на него ссылается (link block, упоминание, значение свойства, членство в коллекции). Если родитель удалён или в архиве, объект с детьми становится корнем, а лист пропадает из дерева. Циклы (возможны только через API и импорт) разрываются по наименьшему id. Ветки подгружаются порциями: 10 корней или 20 детей, затем «Show more». В v0.57.4 `createdInContext` исключили из рёбер графа ([релиз](https://github.com/anyproto/anytype-ts/releases/tag/v0.57.4)).

**Граф.** Глобальный граф пространства: узлы — объекты, рёбра — ссылки, свойства и обратные ссылки. Можно включать подписи, стрелки, иконки и сирот, фильтровать по типам, искать с подсветкой совпадений ([graph.md](https://github.com/anyproto/docs/blob/main/advanced/feature-list-by-platform/graph.md)). Открытые запросы пользователей:
- [#2203](https://github.com/anyproto/anytype-ts/issues/2203) (2026-05-03) — локальный граф в правом сайдбаре: глобальный граф «powerful but adds context switching»;
- [#2142](https://github.com/anyproto/anytype-ts/issues/2142) (2026-04-11) — запоминать позиции перетащенных узлов: сейчас раскладка сбрасывается при каждом входе;
- [#777](https://github.com/anyproto/anytype-ts/issues/777) (2024-06) — фильтры графа, до сих пор открыт;
- на форуме — локальный граф и более гибкие фильтры: «польза глобального графа падает с ростом» ([local-graph-view](https://community.anytype.io/t/local-graph-view/7615), [better-filters](https://community.anytype.io/t/better-filters-for-the-graph-view/5898)).

**Задачи.** Повторяющихся задач нет. Тред с запросом идёт годами, люди держат второе приложение для задач ([recurring-objects](https://community.anytype.io/t/recurring-objects/2109), [techlore](https://discuss.techlore.tech/t/question-about-notion-foss-alternative-anytype/9093)).

**Совместная работа и тарифы.** Shared spaces с E2E-шифрованием, синхронизация в реальном времени и по локальной сети, приглашение по ссылке с одобрением ([collaboration.md](https://github.com/anyproto/docs/blob/main/collaborate/collaboration.md)). Точные лимиты тарифов документация отсылает на `anytype.io/pricing`, который не открылся. В выдержках поиска цифры расходятся: 3 или 10 редакторов на пространство (**не проверено**). Для self-host: «Self-hosters can manage the limits of Viewers/Editors … themselves» ([memberships](https://github.com/anyproto/docs/blob/main/resources/memberships/README.md)). **Anytype for Business** — отдельное приложение с SSO за €20 за редактора в месяц. Ключи хранит auth node. В облачном варианте «мы технически можем получить доступ к содержимому», self-hosted вариант — «coming soon» ([business](https://github.com/anyproto/docs/blob/main/business/README.md)).

**Self-host** (подробно — в §18). Режим local-only помечен как experimental, синхронизация через сетевые диски и сторонние сервисы «скорее всего испортит данные» ([local-only.md](https://github.com/anyproto/docs/blob/main/data/sync-and-backup/local-only.md)).

**MCP.** [`anytype-mcp`](https://github.com/anyproto/anytype-mcp) (MIT, тег v2.0.1) превращает OpenAPI локального API в MCP-инструменты: поиск, пространства, объекты, свойства, типы, шаблоны. Нужен API-ключ из настроек.

**Что взять:** различие «Unlink» и «Move to Bin», Cleanup-список сирот, дерево по месту создания, Queries как основу видов-линз. **Чего избегать:** лицензии не-OSI, невидимой «раздутости» пространства, сброса раскладки графа.

### 4. AFFiNE

**Лицензия.** Корневой `LICENSE`: MIT для всего, кроме `packages/backend` и `packages/common/native` ([LICENSE](https://github.com/toeverything/AFFiNE/blob/canary/LICENSE)). Код там идёт под **AFFiNE Enterprise Edition License**: в продакшне — только с подпиской EE на нужное число мест; патчи принадлежат AFFiNE. Тот же текст называет клиентские части CE лицензией MPL-2.0 ([backend LICENSE](https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/LICENSE)). README при этом пишет: «AFFiNE Community Edition (CE) … free for self-host under the MIT license» и «deploy your own feature-rich, unrestricted version» ([README](https://github.com/toeverything/AFFiNE/blob/canary/README.md)). Для PR нужна подпись CLA (там же). BlockSuite и его отдельный репозиторий разобраны в [R5](R5-board-engine.md).

**Модель.** Документ и edgeless-холст — один и тот же doc в двух режимах. На холст можно положить любой блок: текст, стикеры, веб-страницы, базы данных, связанные страницы, фигуры, слайды ([README](https://github.com/toeverything/AFFiNE/blob/canary/README.md)). С 0.15 (2024-07) есть synced doc embed — трансклюзия документа в другой документ или на холст с обновлением во всех экземплярах ([блог 2024-07](https://affine.pro/blog/whats-new-affine-2024-07), по выдержке поиска). Collections — «умные папки» по правилам (теги, свойства) плюс ручное добавление ([docs collections](https://docs.affine.pro/docs/collections), по выдержке поиска). CRDT — Yjs и y-octo на Rust ([README](https://github.com/toeverything/AFFiNE/blob/canary/README.md)).

**Self-host: лимит мест.**
- [#6641](https://github.com/toeverything/AFFiNE/issues/6641) «Self-hosted not unrestricted» (2024-04-19): 3 участника на пространство, 10 ГБ, ограничение размера файла, 10 вызовов AI даже со своим ключом. Пользователи правили БД вручную; спорили, не нарушает ли это ToS. 2025-02-24 self-host получил квоту Pro, после чего мест стало 10.
- [#13919](https://github.com/toeverything/AFFiNE/issues/13919) (2025-11-13, v0.25.3): лимит 10, поднятый правкой Postgres до 100, сбрасывается при перезапуске контейнера.
- [#15053](https://github.com/toeverything/AFFiNE/issues/15053) (2026-05-31, v0.26.6): ответ мейнтейнера 2026-06-01: «The only way to increase the member limit is the self-hosted team plan».
- Цена: self-host бесплатно до 10 мест на пространство, Team — $10/место/мес при годовой оплате и $12 при помесячной. Installable License активирует места без связи с серверами лицензий ([pricing](https://affine.pro/pricing), [enterprise](https://affine.pro/enterprise), [vs/confluence](https://affine.pro/vs/confluence), по выдержке поиска).

Для Strata это прямо важно: целевая команда (~10 человек) упирается ровно в этот порог.

**Self-host: эксплуатация.** Compose — 4 контейнера: `affine`, `affine_migration`, `redis`, `postgres` (pgvector, pg16) ([compose.yml](https://github.com/toeverything/AFFiNE/blob/canary/.docker/selfhost/compose.yml)). В v0.27.4 (тег 2026-08-17) клиенты должны быть ≥ 0.27, чтобы синхронизироваться с сервером 0.27, а настройки переехали из переменных окружения в `config.json` ([релиз](https://github.com/toeverything/AFFiNE/releases/tag/v0.27.4)).

**Потеря данных и синхронизация.** [#14846](https://github.com/toeverything/AFFiNE/issues/14846) (2026-04, self-hosted 0.26.6, Safari): синхронизация молча перестала работать, после обновления страницы потеряны часы правок; в консоли ошибки транзакций `Y.doc`. Мейнтейнер списал это на Safari и закрыл issue как «not planned». Автор отвечал, что то же было в Brave и что приложение «должно сообщать пользователю, что не может сохранить». Похожие закрытые issues: [#15497](https://github.com/toeverything/AFFiNE/issues/15497) «LOST A WEEK OF DATA» (закрыт 2026-08-19), #14469, #12097 ([поиск по issues](https://github.com/toeverything/AFFiNE/issues?q=is%3Aissue+%22data+loss%22+OR+%22lost+data%22+sync)).

**Производительность холста.** [#14333](https://github.com/toeverything/AFFiNE/issues/14333) (2026-01-28) — запрос ускорить edgeless на больших документах. [#14585](https://github.com/toeverything/AFFiNE/issues/14585) (2026-03-06) — загрузка и правка в Page Mode замедляются пропорционально числу встроенных фреймов. Конкретных порогов не найдено.

**Что взять:** synced embed (одна сущность — много мест) и лёгкий compose. **Чего избегать:** open-core с лимитом мест на сервере, ломающей связки «клиент только той же версии, что сервер», молчаливых сбоев синхронизации.

### 5. Logseq (DB-версия)

- **Статус.** 2.0.1 — первая публичная beta DB-версии (2026-07-13), 2.0.2 — 2026-10-07. Файловая ветка 0.10.x, последний релиз 0.10.15 — 2025-12-01 ([releases](https://github.com/logseq/logseq/releases)). README: «The DB version is in beta status while the new mobile app and RTC is in alpha. This means that **data loss is possible**» ([README](https://github.com/logseq/logseq/blob/master/README.md)). Лицензия — AGPL-3.0 ([LICENSE.md](https://github.com/logseq/logseq/blob/master/LICENSE.md)).
- **Модель.** «Нода» — общее название страницы и блока. **Теги стали классами**: у тега есть Tag Properties, которые наследуют все отмеченные ноды, и `Extends` для наследования между тегами; документация прямо сравнивает это с «types, classes or supertags». Задачи — блоки со встроенным тегом `#Task` и свойствами `Status`, `Priority`, `Deadline`, `Scheduled`; у каждого тега есть готовая таблица-дашборд ([db-version.md](https://github.com/logseq/docs/blob/master/db-version.md), описание от 2026-04-28).
- **Whiteboards удалены**: «Whiteboards have been removed as a feature and will hopefully be available as a plugin». То же со слайдами и встроенным Excalidraw (`/draw`) ([db-version-changes.md](https://github.com/logseq/docs/blob/master/db-version-changes.md)).
- **Sync/RTC** — «paid feature that is currently invite only», при этом сервер можно хостить самому (`Settings > Advanced > Sync Server URL`). Есть встроенный MCP Server ([db-version.md](https://github.com/logseq/docs/blob/master/db-version.md)).
- В R2 отмечено: Logseq сделал Markdown Mirror — одностороннюю проекцию БД в файлы ([R2](R2-obsidian-format.md)).

**Урок:** даже зрелая команда сняла доски с поддержки при переходе на БД. Доска — дорогой компонент, его стоит брать готовым ([R5](R5-board-engine.md)) и держать за адаптером.

### 6. Tana

- **Ноды и ссылки.** Одна нода может стоять в нескольких местах как ссылка; правка в любом месте видна во всех ([nodes-and-references](https://tana.inc/docs/nodes-and-references), по выдержке поиска). **Owner — «дом» ноды, место её создания: владелец один, родителей много** ([FAQ owner vs parent](https://tana.inc/faq/what-is-the-difference-between-the-owner-and-a-parent-of-a-node), по выдержке поиска). Что происходит со ссылками при удалении владельца, найти не удалось.
- **Supertags** — типы с полями поверх нод. Жалобы: без настройки supertags от Tana мало толку, и это отпугивает ([outlinersoftware](https://www.outlinersoftware.com/messages/viewm/42637)); пользователю приходится держать в голове «две-три модели» системы ([ideas #505](https://ideas.tana.inc/posts/505-problem-query-supertag-and-indented-childrens-semantics-are-all-different)); выбор значения в поле «options from supertag» не масштабируется на длинных списках, 2026-01 ([ideas #786](https://ideas.tana.inc/posts/786-selecting-a-node-in-a-options-from-supertag-field-doesnt-scale-beyond-a-few-supertag-instances)).
- **Офлайн** появился в десктопе только в 2025-11. Общие пространства офлайн доступны только для чтения, мобильные приложения офлайн умеют лишь захват ([анонс](https://tana.inc/articles/tana-desktop-now-works-offline-your-knowledge-graph-anywhere), [help](https://outliner.tana.inc/help/mobile-and-desktop)). Есть экспорт в Markdown и JSON и MCP (блог 2026-03, по выдержке поиска).
- **Цены** растут: по стороннему трекеру — Free, Pro $30 и Max $120 за пользователя в месяц на 2026-07 ([costbench](https://costbench.com/software/note-taking/tana/price-history/), **не проверено** по сайту Tana).

**Урок:** «Owner + Parents» — та же модель, что «основное размещение + появления» у Strata. Конструктор типов с первого дня отпугивает.

### 7. Capacities

- Объекты с типами: люди, книги, проекты, встречи — каждый со своими свойствами и шаблонами (обзоры, по выдержке поиска).
- Позиция компании: продукт **только для индивидуальной работы**. «Collaboration & Team plans» стоят в списке «What's not next». Граф по всему пространству — «не решено», приоритет у других видов визуализации ([capacities-is-for-individuals](https://capacities.io/blog/capacities-is-for-individuals), [whats-not-next](https://capacities.io/roadmap/whats-not-next), по выдержке поиска).
- Задачи — в платном Pro; цены в обзорах расходятся (около $9.99–11.99/мес, **не проверено**).

**Урок:** «типизированные объекты» без команды и графа — нишевый продукт. Требование Strata (личная база и команда до 10 человек) этим не закрыть.

### 8. TheBrain (plex)

- **Навигация.** Активная мысль стоит в центре. Родители — сверху, дети — снизу, сиблинги — справа, «jump»-связи (не иерархические) — слева. Клик по любой мысли делает её активной и переносит в центр. **Мысль может иметь больше одного родителя**, поэтому одна и та же мысль появляется в разных позициях в зависимости от того, какая мысль активна ([help Android](https://help.thebrain.com/androidphone/index.html), по выдержке поиска).
- **Навигация за пределами plex:** список недавно посещённых мыслей, пины, поиск и «mapped links» — линейный перечень родителей, детей, сиблингов и jump-связей под заметкой ([Navigating Beyond the Plex](https://thebrain.com/blog/navigating-beyond-the-plex), 2022).
- **Удаление.** Отвязать (unlink), «забыть» (forget) и удалить — три разные операции ([TheBrain 220](https://thebrain.com/blog/TheBrain-220); точную семантику «forget» получить не удалось, **не проверено**).
- **TheBrain 15:** более 150 изменений, агент Cerebro (создаёт мысли и структуры, суммирует вложения, предлагает связи) и Card View — карточки с четырьмя уровнями детализации ([TheBrain 15](https://thebrain.com/products/thebrain/thebrain15), [spotlight 2025-12-16](https://thebrain.com/blog/thebrain-15-feature-spotlight-1), по выдержке поиска). Веб-клиент — 2025-12, Linux — beta с 2026-05.
- **Цены** (магазин, по выдержке поиска): Free для личного использования, Pro $219 разово, Pro Combo $299, затем $159/год, Pro Service $15/место/мес, TeamBrain $25/место/мес ([store](https://thebrain.com/store)).
- **Жалобы** (обзор конкурента, взвешивать осторожно): постоянно видимая сеть перегружает, интерфейс и поиск тормозят на больших базах ([elephas](https://elephas.app/blog/thebrain-review)); у Capterra 4.7/5 по 16 отзывам ([capterra](https://www.capterra.ca/reviews/1062715/thebrain)).

**Урок:** несколько родителей — рабочая модель, которой больше 20 лет. Её минус — потеря ориентации («где я?»). Plex всегда показывает только окрестность, поэтому нужны история и пины. Для Strata это аргумент за строку пути, «Назад/Вперёд» и локальный 3D-режим.

### 9. Obsidian: Canvas, Graph view, Bases

- **Canvas** хранится в `.canvas` (открытый JSON Canvas). Карточки бывают текстовые, файловые, медиа, веб-страницы, базы и папки. Файловую карточку можно сузить до заголовка или блока. Удаление карточки с холста называется **Remove** ([Canvas.md](https://github.com/obsidianmd/obsidian-help/blob/master/en/Plugins/Canvas.md), документация от 2026-10-11). Текстовые карточки не попадают в обратные ссылки, пока их не превратить в файл (там же).
- **Вложенные canvas:** встроенный canvas показывает лишь ссылку, клик открывает исходный файл. Пользователи просят превью, возврат «наверх», редактирование на месте и «выделение → под-canvas» ([forum 49339](https://forum.obsidian.md/t/render-canvas-objects-inside-canvas/49339), [forum 50195](https://forum.obsidian.md/t/canvas-infinitely-zoomable-linkable-nested-cards-inspired-by-infinity-maps/50195), по выдержке поиска; треды 2023 года, текущий статус **не проверен**).
- **Производительность Canvas:** «choppy» на насыщенном холсте; одна карточка на 26 000 символов тормозит даже на топовом железе. Модератор признал баг панорамирования в районах с множеством нод. Обходные пути — настройка «Zoom threshold for hiding card content» и вынос карточек в файлы ([forum 54980](https://forum.obsidian.md/t/canvas-graphics-performance-improvements/54980), [forum 81855](https://forum.obsidian.md/t/i-have-tested-the-13900k-3090-7950x-4090-and-7950x3d-4090-and-there-is-a-serious-issue-with-canvas-performance-no-configuration-can-smoothly-run-a-canvas-card-with-26-000-characters-of-content/81855), по выдержке поиска).
- **Graph view** — core-плагин. Узел крупнее, если на него больше ссылаются. Есть фильтры (поиск, теги, вложения, только существующие файлы, сироты) и цветные группы по поисковому запросу ([Graph view.md](https://github.com/obsidianmd/obsidian-help/blob/master/en/Plugins/Graph%20view.md)).
- **Bases** — табличные и карточные виды по свойствам файлов; данные остаются в Markdown. **Kanban view требует Obsidian 1.14+**. Есть также виды List, Cards, Table и Map ([Kanban view.md](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Layouts/Kanban%20view.md), [Introduction to Bases](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Introduction%20to%20Bases.md)). Это прямой ответ Obsidian на «задачи внутри базы знаний».

### 10. InfraNodus

- **Методика:** текст превращается в сеть со-встречаемости слов. Сообщества выделяются по модулярности, «структурные пробелы» — это далёкие и слабо связанные кластеры. Раскладка Force Atlas в 2D или 3D, хабы расталкиваются ([network-analysis](https://infranodus.com/docs/network-analysis), [how-it-works](https://infranodus.com/about/how-it-works), по выдержке поиска).
- **Плагин Obsidian** с 3D-графом, AI-подсказками и метриками (центральность, модулярность). Нужен ли аккаунт, источники говорят по-разному ([community plugin](https://community.obsidian.md/plugins/infranodus-graph-view), [infranodus.com/obsidian-plugin](https://infranodus.com/obsidian-plugin), по выдержке поиска).
- **Код:** открытая старая версия на Neo4j 3.x, Sigma.js и Graphology. README: «non-commercial venture fiction project»; облако — €9 «towards development and server costs» ([README](https://github.com/noduslabs/infranodus/blob/master/README.md)). Лицензия — **Sustainable Personal Use License (SPUL)**: только личное и внутреннее некоммерческое использование, запрещено «host, deploy, or provide the Software as a service» ([LICENSE.md](https://github.com/noduslabs/infranodus/blob/master/LICENSE.md)). Это не open source.
- **Отзывы:** интерфейс «технический», порог входа высокий; при этом инструмент полезен для поиска пробелов в теме. Всего 3 отзыва на G2, 2022 год ([G2](https://www.g2.com/products/infranodus/reviews), по выдержке поиска).

**Урок:** граф ценен, когда над ним есть **интерпретация** (кластеры, пробелы, центральность), а не просто рисунок.

### 11. Холсты и карточки: Kinopio, Scrintal, Muse, Napkin, Scapple

- **Kinopio.** Код, механики связей и лицензия (PolyForm Noncommercial) разобраны в [R1](R1-houdini-kinopio-ux.md). Бесплатно — 100 карточек и загрузки до 5 МБ, апгрейд $8/мес, $80/год или $250 навсегда. Карточки, добавленные в пространство владельца с апгрейдом, в лимит не идут ([help](https://kinopio.club/help/posts/how-much-does-kinopio-cost/), по выдержке поиска; есть и старая версия страницы со 150 карточками и $4).
- **Scrintal.** «Single archive»: карточку можно положить на любые доски, и **на каждой доске она может выглядеть по-своему**. Убрать карточку с холста — не значит удалить, она возвращается из архива. Импорт Markdown-архива сохраняет двунаправленные ссылки и теги ([cards](https://scrintal.com/features/cards), [single-archive](https://scrintal.com/features/single-archive), по выдержке поиска). Картинки на досках отображаются плохо: показывается верх текста карточки ([feedback 82](https://feedback.scrintal.com/82)). Совместная работа в реальном времени заявлена в стороннем обзоре (**не проверено**).
- **Muse.** Доски внутри досок и linked cards — одна доска в нескольких местах. По отзывам Setapp от 2026-07, продукт переименован в **Allume**; iPhone-версия годится только для захвата ([setapp](https://setapp.com/apps/allume/customer-reviews), по выдержке поиска; переименование **не проверено** по первоисточнику).
- **Napkin** (napkin.one) — заметки-«идеи» с авто-тегами, уклон в осознанность, iPhone ([techcrunch](https://techcrunch.com/?p=2883044), по выдержке поиска). Статус в 2026 не установлен. Для Strata релевантен слабо.
- **Scapple** (Literature & Latte): клик в любом месте — текст, протянул линию — связь, никакой иерархии. Разовая покупка, Mac и Windows ([softwares.com](https://www.softwares.com/software/scapple), по выдержке поиска; цена $18–21 **не проверена**). Урок: захват мысли за секунду без выбора типа.

### 12. Miro / FigJam, Excalidraw+

- **Miro.** Модератор сообщества (2024-08): замедление возможно уже с ~1 000 объектов, рекомендуется держаться ниже 5 000, жёсткий максимум — 100 000. Несколько больших картинок вредят сильнее, чем много стикеров. В 2026-01 пользователи просили индикатор заполненности доски ([community 3110](https://community.miro.com/ask-the-community-45/recommended-number-of-widgets-for-optimal-board-performance-3110), [ideas 27329](https://community.miro.com/ideas/board-size-and-performance-27329), по выдержке поиска). MCP-сервер Miro — с 2026-02 ([dealroom](https://ai-startups.dealroom.co/news/feed/miro-launches-mcp-server-connecting-visual-workspace-with-ai-coding-tools-from-github-aws-and-google), по выдержке поиска). Free — 3 редактируемые доски (сторонний агрегатор, **не проверено**).
- **FigJam.** Холст ограничен: координатам нужна зарезервированная память, а у вкладки браузера есть лимит памяти **2 ГБ**, в том числе в десктопном приложении. Совет — делить большие файлы ([forum.figma.com](https://forum.figma.com/suggest-a-feature-11/make-the-canvas-infinitive-33647), по выдержке поиска).
- **Excalidraw+.** Облачное рабочее пространство с коллекциями сцен, презентации из фреймов (экспорт PDF/PPTX, лазерная указка), комментарии, привязанные к элементам, голосовые созвоны с показом экрана ([plus](https://plus.excalidraw.com/plus), [roadmap](https://plus.excalidraw.com/roadmap), по выдержке поиска). Около $6/мес за пользователя (**не проверено**). Сам движок — MIT, см. [R5](R5-board-engine.md).

### 13. Трекеры: Plane и Linear

- **Plane.** CE — AGPL-3.0 ([LICENSE.txt](https://github.com/makeplane/plane/blob/preview/LICENSE.txt)), v1.4.2 от 2026-08-23. Документация: CE «at par with the Free tier of the Cloud edition»; Commercial Edition — **закрытый код**, 12 бесплатных мест на пространство и апгрейд до платных планов; Airgapped — для изолированных сетей; у каждой редакции своя кодовая база и свой цикл релизов ([editions-and-versions](https://github.com/makeplane/developer-docs/blob/master/docs/self-hosting/editions-and-versions.md)). С 2026-04-24 новые покупки self-hosted Commercial требуют минимум 10 мест, Airgapped — 100 ([forum.plane.so](https://forum.plane.so/t/new-seat-minimums-on-self-hosted-commercial-and-air-gapped-starting-april-24/96), по выдержке поиска). Compose CE — **13 сервисов**: web, space, admin, live, api, worker, beat-worker, migrator, Postgres, Redis, RabbitMQ, MinIO, proxy ([docker-compose.yml](https://github.com/makeplane/plane/blob/preview/deployments/cli/community/docker-compose.yml)). Минимум 2 ядра и 4 ГБ ОЗУ, для продакшна рекомендовано 8 ГБ ([docker-compose.md](https://github.com/makeplane/developer-docs/blob/master/docs/self-hosting/methods/docker-compose.md)). Функции: Cycles с burn-down, Modules, Pages с AI ([README](https://github.com/makeplane/plane/blob/preview/README.md)).
- **Linear.** Только облако, self-host нет. Free — 250 issues; Basic $10 и Business $16 за место при годовой оплате; Cycles, Projects 2.0 с таймлайнами (сторонние агрегаторы, по выдержке поиска: [automationatlas](https://automationatlas.io/answers/linear-pricing-2026/)). Эталон скорости и работы с клавиатуры. Графа и вложенных холстов нет.

**Урок:** трекеры дают статусы, циклы и прогресс, но знания и задачи у них разделены. Пользователи PKM-инструментов ровно поэтому держат «второе приложение для задач» (§16).

### 14. Тема 1. Одна нода в нескольких местах

| Продукт | Как называется | Видно ли, что это «общий экземпляр» | «Убрать отсюда» | «Удалить» | Что с сиротами |
|---|---|---|---|---|---|
| Heptabase | Карточка в Card Library на нескольких досках | Раздел Info и панель «whiteboard location» | Убрать с доски (следует из модели, формулировка не проверена) | В Trash, исчезает со всех досок | Карточка остаётся в библиотеке |
| Anytype | Объект в нескольких Collections, ссылки-блоки | Секция Tree по месту создания, Links | `Unlink from Collection`, удалить блок-ссылку | `Move to Bin` — из всех коллекций и пространства | **Cleanup**: объекты, созданные в удалённом родителе и больше нигде не связанные |
| Tana | Нода-ссылка | Owner («дом») против Parents | Удалить ссылку | — (не найдено) | — |
| TheBrain | Мысль с несколькими родителями | Видна в разных зонах plex | Unlink | Forget / Delete — разные операции | — |
| Scrintal | Карточка в single archive | Разный вид карточки на разных досках | Remove from canvas | — | Остаётся в архиве |
| Obsidian Canvas | Файловая карточка — ссылка на `.md` | Нет специальной пометки | `Remove` | Удаление файла — отдельно | Файл остаётся в хранилище |
| AFFiNE | Synced doc embed | Встроенный блок | Удалить embed | Удалить doc | — |

**Выводы для Strata.**
1. Все разделяют «убрать из этого места» и «удалить сущность». Модель Strata («Убрать отсюда» / «Удалить везде», [05 §5](../05-domain-model.md)) совпадает с практикой. Команды должны называться по-разному и не стоять рядом с одинаковыми иконками.
2. «Дом» нужен. Owner в Tana, `createdInContext` в Anytype и основное размещение Strata — один и тот же паттерн. Anytype показывает дерево по дому, пока родитель ссылается на ребёнка. У Strata это канонический путь.
3. Сироты — неизбежная цена модели. Anytype пришлось сделать Cleanup, потому что пространство «раздувалось». Strata нужен такой же список: ноды без размещений вне корзины по инварианту невозможны, но «призраки» и ноды без нитей и с единственным размещением в забытой сети — возможны.
4. Признак «это появление» в Heptabase виден только в панели карточки. Значок ярлыка на бабле, предложенный в модели, заметнее; он полезнее при массовом переиспользовании (например, нода «Референсы» в нескольких проектах).

### 15. Тема 2. Вложенные холсты и навигация

| Продукт | Вложенность | Строка пути / «вверх» | Превью вложенного | Порог производительности |
|---|---|---|---|---|
| Heptabase | Под-доски; совет — 2 уровня | Не найдено; список досок в сайдбаре | — | ~100–150 карточек на доску (вендор) |
| Obsidian Canvas | Только ссылка на `.canvas` | Нет, просят | Нет, просят | «Choppy» на насыщенном холсте |
| Muse / Allume | Доски в досках | — | — | — |
| AFFiNE | Doc ⇄ edgeless, embeds | Через дерево документов | Embed | Жалобы на большие документы |
| Logseq DB | Whiteboards удалены | — | — | — |
| TheBrain | Нет холстов, plex | История, пины, mapped links | Только окрестность | Поиск тормозит на больших базах (обзор) |
| Miro | Фреймы | — | — | ~1 000–5 000 объектов |
| **Strata (план)** | Сети любой глубины | Строка пути, `Enter`/`I`, `U` ([R1](R1-houdini-kinopio-ux.md)) | 💡 Миниатюра в превью | Цель — тысячи нод |

**Выводы.** Конкуренты избегают глубины, потому что холст у них дорог: каждая карточка несёт содержимое. Strata грузит в сеть только индекс и превью (N1, [05 §13](../05-domain-model.md)), и это стоит сделать измеримым преимуществом (рекомендация 3). Запросы пользователей Obsidian (превью под-холста, «выделение → под-холст», возврат наверх) уже закрываются Houdini-механиками: Collapse into Subnet, `U`, строка пути.

### 16. Тема 3. Задачи внутри графа знаний

Чего не хватает пользователям (по найденным источникам):

| Пробел | Где замечен | Источник |
|---|---|---|
| Повторяющиеся задачи | Anytype (годами), уход в Super Productivity | [anytype 2109](https://community.anytype.io/t/recurring-objects/2109), [techlore](https://discuss.techlore.tech/t/question-about-notion-foss-alternative-anytype/9093) |
| Напоминания о сроках | Heptabase: группы по дате есть, уведомлений не найдено | [newsletter 2023-11-30](https://wiki.heptabase.com/newsletters/2023-11-30) |
| Вид «что горит» поверх тех же объектов | Obsidian добавил Kanban в Bases (1.14), Logseq — таблицы тегов | [Kanban view](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Layouts/Kanban%20view.md), [db-version](https://github.com/logseq/docs/blob/master/db-version.md) |
| Совместная работа над задачами | Capacities принципиально без команд | [whats-not-next](https://capacities.io/roadmap/whats-not-next) |
| Прогресс и циклы | Есть у трекеров (Plane Cycles с burn-down), у PKM-инструментов не найдено | [Plane README](https://github.com/makeplane/plane/blob/preview/README.md) |
| Связь задачи с контекстом | У трекеров знания отдельно (Pages в Plane), у PKM — отдельный список задач | §13 |

**Выводы.** Рабочий паттерн — «задача = атрибуты на любой ноде + виды-запросы»: Logseq `#Task`, Anytype Types/Queries, Obsidian Bases. Он совпадает с принципом 3 модели Strata («атрибуты не зависят от вида») и с линзами и видами-линзами из глоссария. Отличия, которых нет у PKM-конкурентов: **свёртки** (прогресс и ближайший дедлайн сети, [05 §6.4](../05-domain-model.md)) и **визуальная срочность прямо на графе** (свечение и пульсация дедлайна, [05 §6.3](../05-domain-model.md)).

### 17. Тема 4. 3D и графовые виды: польза или витрина

**Что говорят пользователи.**
- Форум Obsidian, 2026: тред «You All Say the Graph Is Useless…» признаёт, что жалоба «красивый, но бесполезный» распространена. Глобальный граф «не несёт информации»: тысячи узлов, плотная масса. Полезными называют локальный граф и фильтрацию поисковым синтаксисом ([forum 116738](https://forum.obsidian.md/t/you-all-say-the-graph-is-useless-let-me-show-you-how-to-use-it/116738), по выдержке поиска).
- Тред «What's the point of the graph view?» и блоги: граф — «topology viewer», отвечает лишь на вопрос «что с чем связано», без метрик и интерпретации ([forum 71316](https://forum.obsidian.md/t/whats-the-point-of-the-graph-view-how-are-you-using-it/71316), [codeculture](https://codeculture.store/blogs/developer-culture/obsidian-graph-view-useful), по выдержке поиска).
- Защитники: граф — быстрая проверка здоровья базы (сироты, забытые индексы, сбои синхронизации) ([eleanorkonik](https://www.eleanorkonik.com/its-not-just-a-pretty-gimmick-in-defense-of-obsidians-graph-view), по выдержке поиска). С ростом базы автор блога перешёл на локальные графы ([pjordan](https://pjordan.substack.com/p/a-pkm-revelation-obsidian-local-graphs)).
- Anytype 2026: просят локальный граф рядом с редактором (#2203) и стабильные позиции (#2142); фильтры (#777) просят с 2024 года.
- 3D-плагины Obsidian: у «3D Graph New» около 19 000 загрузок. «Advanced Graph View» обещает 3D как инструмент анализа вместо «hairball». «Galaxy View» открыто заявляет эстетику как цель ([obsidianstats 3d-graph-new](https://www.obsidianstats.com/plugins/3d-graph-new), [graph-insight](https://www.obsidianstats.com/plugins/graph-insight), по выдержке поиска). Отзывов и данных об удержании нет.

**Что говорят исследования** (по выдержкам поиска; первоисточники открыты частично):
- Сравнение 2D, 3D и 3D-спирали на 36 участниках (Hicks et al., 2003): преимущество у 2D ([repository.essex.ac.uk](https://repository.essex.ac.uk/7904/), атрибуция **не проверена**).
- Alper et al. (2011): 3D-раскладки требуют больше навигации точкой обзора, а при вращении граф выглядит по-разному, что мешает строить ментальную карту ([PDF](https://sites.cs.ucsb.edu/~holl/pubs/Alper-2011-Infovis.pdf)).
- Иммерсивные сети: часть участников легче разрешала перекрытия рёбер в 3D, другие предпочитали 2D для обзора и запоминания ([arXiv 2001.06462](https://arxiv.org/pdf/2001.06462)). В 3D больше перекрытий, и узел перед ребром ложно намекает на связь ([arXiv 2506.09212](https://arxiv.org/pdf/2506.09212)).

**Что делает граф полезным** (сводка):

| Свойство | Пример | Для Strata |
|---|---|---|
| Локальность (N шагов от текущей ноды) | Obsidian local graph, запрос Anytype #2203, plex TheBrain | Локальный режим 3D вокруг ноды и пути |
| Стабильные позиции | Запрос Anytype #2142 | Детерминированная раскладка с сохранением позиций; пользователь может закрепить звезду |
| Фильтры и группы | Obsidian Groups, Anytype Filter by Types | Линзы (статус, дедлайн, ответственный, тег) |
| Интерпретация | InfraNodus: сообщества, пробелы, центральность | Скопления = сети; 💡 сообщества и «мосты» как линза |
| Действия, а не только просмотр | Anytype: поиск → Enter → переход | Поиск-полёт, нырок, создание ноды в 3D (требование владельца) |
| Здоровье базы | Сироты в графе Obsidian | Подсветка сирот и призраков |

### 18. Тема 5. Self-hosting: подводные камни

| Продукт | Что разворачивать | Лимиты | Найденные проблемы |
|---|---|---|---|
| Anytype | 8 сервисов: coordinator, 3× sync node, filenode, consensus, MongoDB, Redis, Garage; около 1 ГБ ОЗУ; compose — «for personal use, review, or testing», для продакшна — Puppet/Ansible ([README](https://github.com/anyproto/any-sync-dockercompose)) | Лимиты редакторов задаёт сам self-hoster | Образы MinIO удалены, понадобилась миграция на Garage, стек не стартует без миграции (#199, #178, #204, 2026-09). Зависимость от `make` мешает Portainer, TrueNAS и Coolify (#164, #181, #184, #194). Медленная синхронизация (#175, #203). Неоднозначные параметры конфига ломают синхронизацию (#171). Клиент на self-hosted сеть переключается только через выход из аккаунта и загрузку `.yml` на каждом устройстве; рекомендуют отдельную identity ([issues](https://github.com/anyproto/any-sync-dockercompose/issues), [self-host.md](https://github.com/anyproto/docs/blob/main/data/sync-and-backup/self-host.md)) |
| AFFiNE | 4 контейнера (app, migration, Redis, Postgres+pgvector) | **10 мест на пространство** без платного плана | Ручные правки БД сбрасываются (#13919). Клиент обязан быть ≥ версии сервера (0.27). Конфиг переехал из env в `config.json`. Молчаливый сбой синхронизации (#14846) |
| Plane CE | 13 сервисов, 2 ядра и 4 ГБ (8 ГБ для продакшна) | Без лимитов, но паритет только с Free-облаком; платные функции — в закрытой редакции | Разные кодовые базы редакций, переход на Commercial — смена дистрибутива |
| Logseq DB | Сервер sync (self-host возможен) | Sync — платная alpha по приглашениям | «Data loss is possible» (README) |

**Выводы.** Команде из 10 человек без DevOps нужны: один процесс или контейнер; одна встроенная БД (SQLite, как в гипотезе [01](../01-analysis.md)); один конфиг-файл; совместимость клиента с сервером хотя бы на одну минорную версию назад; встроенная диагностика вроде `netcheck` у Anytype; подключение существующего локального пространства к серверу без выхода из аккаунта и без новой identity; **никаких лимитов мест в коде**; видимый статус «не синхронизировано» и блокировка закрытия вкладки с несохранённым.

### 19. MCP и AI у конкурентов

| Продукт | MCP | Источник |
|---|---|---|
| Heptabase | Да, с v1.81.2 (2025-12-11): чтение, поиск, запись карточек и журналов | [roadmap](https://wiki.heptabase.com/roadmap), [support](https://support.heptabase.com/en/articles/12679581) (по выдержке поиска) |
| Anytype | `anytype-mcp` (MIT, v2.0.1) поверх локального API | [GitHub](https://github.com/anyproto/anytype-mcp) |
| Logseq DB | Встроенный MCP Server | [db-version.md](https://github.com/logseq/docs/blob/master/db-version.md) |
| Miro | С 2026-02, OAuth | [dealroom](https://ai-startups.dealroom.co/news/feed/miro-launches-mcp-server-connecting-visual-workspace-with-ai-coding-tools-from-github-aws-and-google) (по выдержке поиска) |
| Tana | Tana API и MCP (блог 2026-03) | по выдержке поиска |
| TheBrain | Встроенный агент Cerebro (не MCP) | [TheBrain 15](https://thebrain.com/products/thebrain/thebrain15) |
| AFFiNE | Встроенный AI, BYOK — экспериментально (0.27.4) | [релиз](https://github.com/toeverything/AFFiNE/releases/tag/v0.27.4) |

Самого по себе MCP мало, чтобы выделиться. Отличие Strata по [R6](R6-mcp-ai.md) — операции над графом (`apply_graph_plan`, вставка в нить, размещение), журнал агента и откат одной командой.

## Сравнение вариантов

### Продукты по требованиям Strata

| Требование Strata | Heptabase | Anytype | AFFiNE | Logseq DB | Tana | TheBrain | Obsidian | Plane |
|---|---|---|---|---|---|---|---|---|
| Нодовая навигация, вложенность любой глубины, путь | ⚠️ 2 уровня досок, пути нет | ❌ (дерево created-in) | ⚠️ дерево документов | ❌ | ⚠️ outline | ⚠️ plex без пути | ❌ | ❌ |
| Одна нода — много мест | ✅ | ✅ | ✅ embed | ✅ ссылки | ✅ Owner/Parents | ✅ multi-parent | ⚠️ файл на холстах | ❌ |
| Задачи + виды | ⚠️ без напоминаний | ⚠️ без повторов | ⚠️ базы | ✅ `#Task` | ✅ supertags | ⚠️ базово | ✅ Bases Kanban (1.14) | ✅ |
| Доска внутри ноды | ✅ | ❌ | ✅ edgeless | ❌ удалены | ❌ | ❌ | ✅ Canvas | ❌ |
| Тысячи нод без лагов | ❌ ~100–150 на доску | ? | ⚠️ жалобы | ? | ? | ⚠️ жалобы | ⚠️ Canvas тормозит | — |
| 3D | ❌ | ❌ (2D-граф) | ❌ | ❌ | ❌ | ❌ | Плагины | ❌ |
| Real-time для команды ~10 | ✅ облако | ✅ E2E | ✅ | ⚠️ alpha | ✅ облако | ✅ TeamBrain | ❌ | ✅ |
| Self-host без лимитов | ❌ | ⚠️ 8 сервисов | ❌ 10 мест | ⚠️ alpha | ❌ | ❌ | ❌ | ✅ CE (13 сервисов) |
| OSI-лицензия | ❌ | ❌ ASAL | ⚠️ MIT + EE | ✅ AGPL | ❌ | ❌ | ❌ | ✅ AGPL (CE) |
| MCP | ✅ | ✅ | ⚠️ AI внутри | ✅ | ✅ | ⚠️ свой агент | Плагины | ? |
| Импорт Obsidian | ✅ | ✅ ([migrate-from-obsidian](https://github.com/anyproto/docs/blob/main/data/import-and-export/migrate-from-obsidian.md)) | ⚠️ импортёры (0.27) | — | ? | ? | — | ❌ |

✅ есть · ⚠️ частично или с оговорками · ❌ нет · ? не проверено

### Что берём и чего избегаем

| Что | Берём или избегаем | У кого | Почему для Strata |
|---|---|---|---|
| Библиотека нод + размещения на холстах | **Берём** (уже в модели) | Heptabase, Scrintal | Требование «одна нода в нескольких ветках» |
| Две команды: «Убрать отсюда» и «Удалить везде» | **Берём** | Anytype (`Unlink` / `Move to Bin`), Obsidian `Remove` | Предсказуемое удаление общих нод |
| Список сирот | **Берём** | Anytype Cleanup | Модель «нода живёт отдельно» неизбежно копит мусор |
| «Дом» ноды | **Берём** (основное размещение) | Tana Owner, Anytype created-in | Канонический путь, восстановление из корзины |
| Панель «Где ещё размещена» | **Берём** | Heptabase whiteboard location | Навигация между появлениями |
| Разный вид появления в разных сетях | **Берём** (размер и свёрнутость на размещение уже в документе сети) | Scrintal | Одна нода — крупная в одном проекте, мелкая в другом |
| Sections/рамки вместо лишней вложенности | **Берём** (network boxes) | Heptabase Sections, Houdini | Меньше глубины там, где хватает группировки |
| Задачи = атрибуты + запросы-виды | **Берём** | Logseq `#Task`, Obsidian Bases, Anytype Queries | Принцип 3 модели, линзы |
| Сообщества и пробелы как аналитика | **Берём как линзу** (этап 2) | InfraNodus | Смысл 3D сверх картинки |
| Локальный граф и стабильные позиции | **Берём** | Obsidian, запросы Anytype | Без них 3D — витрина |
| Агент с операциями над графом | **Берём** (уже в R6) | TheBrain Cerebro, Heptabase MCP | MCP — гигиена, ценность в операциях |
| Потолок 100–5 000 объектов на холст | **Избегаем** | Heptabase, Miro, Obsidian Canvas | Требование N1 «тысячи нод без лагов» |
| Двухуровневая вложенность «по совету вендора» | **Избегаем** | Heptabase | Houdini-навигация в глубину — ядро продукта |
| Open-core с лимитом мест на сервере | **Избегаем** | AFFiNE EE, Plane Commercial | Команда ~10 человек упирается ровно в порог |
| Не-OSI лицензия | **Избегаем** | Anytype ASAL, InfraNodus SPUL, Kinopio PolyForm NC | Open source, «каждый хостит сам» (бриф) |
| Зоопарк сервисов в self-host | **Избегаем** | Anytype (8), Plane (13) | Хостят люди без DevOps |
| Жёсткая сцепка версий клиента и сервера | **Избегаем** | AFFiNE 0.27 | Десктоп и сервер обновляются в разное время |
| Молчаливый сбой синхронизации | **Избегаем** | AFFiNE #14846 | Потеря доверия к данным |
| Конструктор типов как обязательный первый шаг | **Избегаем** | Tana supertags | Порог входа и так высок (Houdini-UX) |
| Сброс раскладки графа при каждом входе | **Избегаем** | Anytype #2142 | Пространственная память пользователя |
| Глобальный «волосяной шар» как главный вид | **Избегаем** | Obsidian global graph | Признан «бесполезным» многими пользователями |
| Доска как самописный монолит | **Избегаем** | Logseq удалил whiteboards | Берём движок за адаптером ([R5](R5-board-engine.md)) |

## Рекомендация для Strata

1. **Сделать удаление общих нод явным и одинаковым везде.**
   - На холсте `Delete` — это «Убрать отсюда» (с залечиванием цепочки, [05 §8.4](../05-domain-model.md)), `Shift+Delete` — «Удалить везде».
   - Если у ноды больше одного размещения, диалог перечисляет их пути: «Нода размещена в 3 сетях: …». Так Anytype и Heptabase разводят unlink и delete.
   - **Удаление сети** уточнить в [05](../05-domain-model.md) (каскад сейчас не описан). Вложенные ноды без других размещений уходят в корзину вместе с сетью одним шагом отмены. Ноды с другими размещениями теряют только это размещение; если оно было основным, основным становится следующее (Q-R8-1).
   - **Список сирот** по образцу Anytype Cleanup: ноды, которые после удаления ссылки `[[…]]` или нити остались без единой нити и с одним размещением, плюс неразрешённые призраки. Это подсказки, а не автоудаление. Термин нужно добавить в глоссарий.
2. **Показывать появление на самом бабле, а не только в инспекторе.** Значок ярлыка и счётчик «×3» из модели оставить. По клику — панель «Где размещена» с путями и переходом, как whiteboard location в Heptabase. В строке пути для появления показывать канонический путь серым и путь, по которому пришли, — белым. Так снимается дезориентация «где я», знакомая по plex TheBrain.
3. **Превратить производительность в измеримое преимущество.** Конкуренты публично упираются в 100–150 карточек (Heptabase), 1 000–5 000 объектов (Miro) и в «choppy» Canvas. Strata стоит закрепить бенчмарк в CI: **5 000 баблов в одной сети при 60 fps** на среднем ноутбуке и 100 000 нод в индексе (замеры R3/R4). Средство — LOD: при отдалении бабл рисуется без подписи и иконки, как «Zoom threshold for hiding card content» в Obsidian. Содержимое на холсте не рендерится вовсе, только превью (N1). Порог 5 000 — предложение, нужно подтверждение (Q-R8-5).
4. **Сделать глубину сильной стороной.** Строка пути, `Enter`/`I`, `U`, «Назад/Вперёд» и миниатюра вложенной сети в превью бабла закрывают запросы, которые пользователи Obsidian Canvas оставляют с 2023 года. Операция «Обернуть в сеть» ([05 §4.2](../05-domain-model.md)) — ответ на запрос «выделение → под-холст». В онбординге не советовать «держать два уровня»: это ограничение Heptabase, а не закон природы.
5. **Задачи — через атрибуты, линзы и виды-линзы, а отличие — в свёртках и визуальной срочности.** MVP: статус, дедлайн, ответственные на любой ноде; линзы на холсте; вид-линза «список» по запросу. Канбан и календарь — этап 2, как у Obsidian Bases и Logseq. В модели сразу предусмотреть поле повторения и канал напоминаний: этого не хватает пользователям Heptabase и Anytype (Q-R8-2). Свёртки прогресса по вложенным сетям — то, чего у PKM-конкурентов нет.
6. **3D должен отвечать на вопросы, а не только красиво выглядеть.**
   - Позиции звёзд детерминированы и сохраняются; пользователь может закрепить звезду (Anytype #2142).
   - Скопления по умолчанию — сети, то есть вложенность.
   - Есть **локальный режим**: N шагов от текущей ноды и её пути (Obsidian local graph, Anytype #2203).
   - Линзы работают в 3D так же, как в 2D.
   - Подсветка сирот и призраков как «проверка здоровья» базы.
   - Этап 2 — линза «сообщества и мосты» по модулярности, как у InfraNodus.
   - Рабочим режимом остаётся 2D: исследования показывают, что для обзора и запоминания 2D быстрее. Значит, 3D должен быть быстрым входом «найти → подлететь → нырнуть» (требование владельца), а не заменой холста.
7. **Self-host — один бинарник без лимитов мест.** Один процесс или контейнер, SQLite внутри, один конфиг, команда `strata doctor` для проверки портов, TLS и версии. Клиент совместим с сервером минимум на одну минорную версию назад. Локальное пространство публикуется на сервер без выхода из аккаунта. В интерфейсе всегда виден статус синхронизации, а при несохранённых правках закрытие вкладки блокируется (`beforeunload`). Никакого деления на CE и EE на сервере: именно на этом теряют доверие AFFiNE и Plane.
8. **Выбрать OSI-лицензию и не брать чужой несвободный код.** Свободная лицензия — реальное отличие от Anytype (ASAL), Heptabase, TheBrain, Tana и Capacities (закрыты), а также от бэкенда AFFiNE (EE). Код Anytype, InfraNodus (SPUL), Kinopio (PolyForm NC) и серверной части AFFiNE не переносить. Из AGPL-проектов (Plane, Logseq) — только если Strata сама будет AGPL. Это не юридическая консультация; связано с открытым вопросом о лицензии (Q-R5-9, Q-R8-4).
9. **Не делать конструктор типов обязательным.** Классы «Задача» и «Проект» — готовые пресеты; пользовательские классы — этап 2 ([05 §4.3](../05-domain-model.md)). Опыт Tana: если ценность появляется только после настройки supertags, людей это отпугивает. Новая нода создаётся в один шаг (`Tab` → имя → `Enter`), как в Scapple: кликнул и пишешь.
10. **Импорт Obsidian без потери связей, а за ним — Heptabase и Anytype.** Scrintal и Anytype уже продают «переезд из Obsidian с сохранением связей», так что для Strata это входной билет (MVP). Heptabase отдаёт Markdown, Anytype — свой экспорт. Обоих стоит рассмотреть как второй источник импорта: там аудитория, которой не хватает задач или self-host (Q-R8-6). Крупный импорт делать фоновым и пакетным: Heptabase прямо предупреждает, что импорт бьёт по производительности.

## Риски

- **Многоместность путает людей.** Anytype пишет, что удаление при такой модели «труднее понять», и добавил Cleanup. Пользователи Tana жалуются на «несколько ментальных моделей». У Strata вдобавок глобальные нити и несколько путей у одной ноды. Без явной UX-подачи (рекомендации 1–2) это главный источник ошибок.
- **Порог входа Houdini-UX.** На высокий порог жалуются у TheBrain, InfraNodus и Tana. Strata целится в ещё более «профессиональный» UX. Нужны демо-пространство и подсказки ([01 §3](../01-analysis.md)).
- **Амбиция по производительности.** Все конкуренты упираются в сотни или тысячи объектов на холст. Обещание «тысячи нод без лагов» нужно проверять бенчмарком с первого прототипа, иначе отличие превратится в такой же потолок.
- **3D станет витриной.** Опыт Obsidian: без локальности, фильтров и стабильных позиций граф быстро бросают.
- **Нагрузка на поддержку self-host.** У `any-sync-dockercompose` 116 страниц issues. Каждая внешняя зависимость (MinIO, MongoDB, Redis) — будущая миграция.
- **Доски дорогие.** Logseq снял whiteboards при переходе на БД. Если доска в Strata разрастётся за рамки адаптера к Excalidraw, она съест бюджет MVP.
- **Темп конкурентов в AI.** Heptabase, Anytype, Logseq, Miro и Tana уже выпустили MCP. Окно «первого с MCP» закрыто.
- **Качество источников.** Часть фактов о Heptabase, TheBrain, Tana, Capacities, Miro и InfraNodus взята из поисковых выдержек: сайты недоступны из среды исследования. Цены и тарифы меняются быстрее всего (Tana — дважды за 2026 год).
- **Лицензионная ловушка.** Случайный перенос кода из ASAL, SPUL, PolyForm NC, EE или AGPL (при не-AGPL Strata) создаст юридический долг.

## Открытые вопросы

- **Q-R8-1.** Что происходит при удалении сети с вложенными нодами? Предложение: ноды без других размещений уходят в корзину вместе с сетью, ноды с другими размещениями теряют только это размещение. Подходит ли так, или нужен диалог с выбором по каждой общей ноде?
- **Q-R8-2.** Нужны ли в MVP напоминания о дедлайнах (системные уведомления, email) и повторяющиеся задачи? Если нет, оставляем ли место в модели (поле повторения), чтобы не мигрировать позже?
- **Q-R8-3.** Позиции звёзд в 3D: «живая» физика при каждом входе, детерминированная раскладка или сохранённые позиции с возможностью закрепить? Связано с H2 из [опросника](../02-questions.md).
- **Q-R8-4.** Модель лицензии и денег: вся кодовая база, включая сервер, под одной OSI-лицензией без платных мест? Планируется ли платный хостинг, который потянет за собой open-core? Связано с Q-R5-9.
- **Q-R8-5.** Целевая производительность одной сети: сколько баблов на экране должно оставаться плавным (1 000, 5 000, больше) и на каком железе?
- **Q-R8-6.** Какой импорт после Obsidian важнее: Heptabase, Anytype, Logseq или Notion? Продолжение L2 из [опросника](../02-questions.md).
- **Q-R8-7.** Нужно ли E2E-шифрование совместных пространств, как у Anytype? Оно несовместимо с серверным MCP и поиском по смыслу (см. [R3](R3-crdt-sync.md), [R6](R6-mcp-ai.md)).
- **Q-R8-8.** Значок появления на бабле: всегда виден или только при наведении? При активном переиспользовании (референсы в каждом проекте) постоянный значок может шуметь.

## Источники

**Лицензии и релизы (первоисточники)**
- https://github.com/anyproto/anytype-ts/blob/main/LICENSE.md
- https://github.com/anyproto/anytype-heart/blob/main/LICENSE.md
- https://github.com/anyproto/any-sync/blob/main/LICENSE.md
- https://github.com/toeverything/AFFiNE/blob/canary/LICENSE
- https://github.com/toeverything/AFFiNE/blob/canary/packages/backend/server/LICENSE
- https://github.com/makeplane/plane/blob/preview/LICENSE.txt
- https://github.com/logseq/logseq/blob/master/LICENSE.md
- https://github.com/noduslabs/infranodus/blob/master/LICENSE.md
- https://github.com/anyproto/anytype-ts/releases/tag/v0.57.4
- https://github.com/toeverything/AFFiNE/releases/tag/v0.27.4
- https://github.com/makeplane/plane/releases/tag/v1.4.2
- https://github.com/logseq/logseq/releases

**Heptabase**
- https://wiki.heptabase.com/fundamental-elements
- https://wiki.heptabase.com/nested-whiteboard
- https://wiki.heptabase.com/organize-knowledge-and-projects
- https://wiki.heptabase.com/collaborate-and-discuss-with-others
- https://wiki.heptabase.com/roadmap
- https://wiki.heptabase.com/version-one
- https://wiki.heptabase.com/newsletters
- https://wiki.heptabase.com/newsletters/2023-11-30
- https://wiki.heptabase.com/ama-2024-11
- https://wiki.heptabase.com/data-safety
- https://support.heptabase.com/en/articles/11430704-troubleshooting-performance-and-lag-issues-in-heptabase
- https://support.heptabase.com/en/articles/10447264-how-to-restore-deleted-cards-and-whiteboards-from-trash
- https://support.heptabase.com/en/articles/10364279-how-sustainable-is-heptabase-can-i-easily-export-my-data-and-move-on
- https://support.heptabase.com/en/articles/12679581
- https://support.heptabase.com/en/articles/12990121

**Anytype**
- https://github.com/anyproto/docs/blob/main/organize/deletion.md
- https://github.com/anyproto/docs/blob/main/organize/collections.md
- https://github.com/anyproto/docs/blob/main/organize/queries.md
- https://github.com/anyproto/docs/blob/main/advanced/feature-list-by-platform/graph.md
- https://github.com/anyproto/docs/blob/main/data/sync-and-backup/self-host.md
- https://github.com/anyproto/docs/blob/main/data/sync-and-backup/local-only.md
- https://github.com/anyproto/docs/blob/main/data/import-and-export/migrate-from-obsidian.md
- https://github.com/anyproto/docs/blob/main/resources/memberships/README.md
- https://github.com/anyproto/docs/blob/main/collaborate/collaboration.md
- https://github.com/anyproto/docs/blob/main/business/README.md
- https://github.com/anyproto/anytype-ts/pull/2396
- https://github.com/anyproto/anytype-ts/issues/2142
- https://github.com/anyproto/anytype-ts/issues/2203
- https://github.com/anyproto/anytype-ts/issues/777
- https://github.com/anyproto/any-sync-dockercompose
- https://github.com/anyproto/any-sync-dockercompose/issues
- https://github.com/anyproto/anytype-mcp
- https://community.anytype.io/t/local-graph-view/7615
- https://community.anytype.io/t/better-filters-for-the-graph-view/5898
- https://community.anytype.io/t/recurring-objects/2109
- https://discuss.techlore.tech/t/question-about-notion-foss-alternative-anytype/9093
- https://discuss.privacyguides.net/t/question-about-notion-foss-alternative-anytype/19191
- https://isitreallyfoss.com/projects/anytype
- https://outlinersoftware.com/topics/viewt/9794/10

**AFFiNE**
- https://github.com/toeverything/AFFiNE/blob/canary/README.md
- https://github.com/toeverything/AFFiNE/blob/canary/.docker/selfhost/compose.yml
- https://github.com/toeverything/AFFiNE/issues/6641
- https://github.com/toeverything/AFFiNE/issues/13919
- https://github.com/toeverything/AFFiNE/issues/15053
- https://github.com/toeverything/AFFiNE/issues/14846
- https://github.com/toeverything/AFFiNE/issues/15497
- https://github.com/toeverything/AFFiNE/issues/14333
- https://github.com/toeverything/AFFiNE/issues/14585
- https://github.com/toeverything/AFFiNE/issues?q=is%3Aissue+%22data+loss%22+OR+%22lost+data%22+sync
- https://affine.pro/pricing
- https://affine.pro/enterprise
- https://affine.pro/vs/confluence
- https://affine.pro/blog/whats-new-affine-2024-07
- https://docs.affine.pro/docs/collections

**Logseq**
- https://github.com/logseq/logseq/blob/master/README.md
- https://github.com/logseq/docs/blob/master/db-version.md
- https://github.com/logseq/docs/blob/master/db-version-changes.md

**Tana, Capacities, TheBrain**
- https://tana.inc/docs/nodes-and-references
- https://tana.inc/faq/what-is-the-difference-between-the-owner-and-a-parent-of-a-node
- https://tana.inc/articles/tana-desktop-now-works-offline-your-knowledge-graph-anywhere
- https://outliner.tana.inc/help/mobile-and-desktop
- https://ideas.tana.inc/posts/505-problem-query-supertag-and-indented-childrens-semantics-are-all-different
- https://ideas.tana.inc/posts/786-selecting-a-node-in-a-options-from-supertag-field-doesnt-scale-beyond-a-few-supertag-instances
- https://www.outlinersoftware.com/messages/viewm/42637
- https://costbench.com/software/note-taking/tana/price-history/
- https://capacities.io/blog/capacities-is-for-individuals
- https://capacities.io/roadmap/whats-not-next
- https://help.thebrain.com/androidphone/index.html
- https://thebrain.com/blog/navigating-beyond-the-plex
- https://thebrain.com/blog/TheBrain-220
- https://thebrain.com/products/thebrain/thebrain15
- https://thebrain.com/blog/thebrain-15-feature-spotlight-1
- https://thebrain.com/store
- https://elephas.app/blog/thebrain-review
- https://www.capterra.ca/reviews/1062715/thebrain

**Obsidian**
- https://github.com/obsidianmd/obsidian-help/blob/master/en/Plugins/Canvas.md
- https://github.com/obsidianmd/obsidian-help/blob/master/en/Plugins/Graph%20view.md
- https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Introduction%20to%20Bases.md
- https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Layouts/Kanban%20view.md
- https://forum.obsidian.md/t/you-all-say-the-graph-is-useless-let-me-show-you-how-to-use-it/116738
- https://forum.obsidian.md/t/whats-the-point-of-the-graph-view-how-are-you-using-it/71316
- https://forum.obsidian.md/t/render-canvas-objects-inside-canvas/49339
- https://forum.obsidian.md/t/canvas-infinitely-zoomable-linkable-nested-cards-inspired-by-infinity-maps/50195
- https://forum.obsidian.md/t/canvas-graphics-performance-improvements/54980
- https://forum.obsidian.md/t/i-have-tested-the-13900k-3090-7950x-4090-and-7950x3d-4090-and-there-is-a-serious-issue-with-canvas-performance-no-configuration-can-smoothly-run-a-canvas-card-with-26-000-characters-of-content/81855
- https://www.eleanorkonik.com/its-not-just-a-pretty-gimmick-in-defense-of-obsidians-graph-view
- https://pjordan.substack.com/p/a-pkm-revelation-obsidian-local-graphs
- https://codeculture.store/blogs/developer-culture/obsidian-graph-view-useful
- https://www.obsidianstats.com/plugins/3d-graph-new
- https://www.obsidianstats.com/plugins/graph-insight

**InfraNodus**
- https://github.com/noduslabs/infranodus/blob/master/README.md
- https://infranodus.com/docs/network-analysis
- https://infranodus.com/about/how-it-works
- https://infranodus.com/obsidian-plugin
- https://community.obsidian.md/plugins/infranodus-graph-view
- https://www.g2.com/products/infranodus/reviews

**Холсты, доски, трекеры**
- https://kinopio.club/help/posts/how-much-does-kinopio-cost/
- https://scrintal.com/features/cards
- https://scrintal.com/features/single-archive
- https://feedback.scrintal.com/82
- https://setapp.com/apps/allume/customer-reviews
- https://techcrunch.com/?p=2883044
- https://www.softwares.com/software/scapple
- https://community.miro.com/ask-the-community-45/recommended-number-of-widgets-for-optimal-board-performance-3110
- https://community.miro.com/ideas/board-size-and-performance-27329
- https://ai-startups.dealroom.co/news/feed/miro-launches-mcp-server-connecting-visual-workspace-with-ai-coding-tools-from-github-aws-and-google
- https://forum.figma.com/suggest-a-feature-11/make-the-canvas-infinitive-33647
- https://plus.excalidraw.com/plus
- https://plus.excalidraw.com/roadmap
- https://github.com/makeplane/plane/blob/preview/README.md
- https://github.com/makeplane/plane/blob/preview/deployments/cli/community/docker-compose.yml
- https://github.com/makeplane/developer-docs/blob/master/docs/self-hosting/editions-and-versions.md
- https://github.com/makeplane/developer-docs/blob/master/docs/self-hosting/methods/docker-compose.md
- https://forum.plane.so/t/new-seat-minimums-on-self-hosted-commercial-and-air-gapped-starting-april-24/96
- https://automationatlas.io/answers/linear-pricing-2026/

**Исследования 2D/3D**
- https://repository.essex.ac.uk/7904/
- https://sites.cs.ucsb.edu/~holl/pubs/Alper-2011-Infovis.pdf
- https://arxiv.org/pdf/2001.06462
- https://arxiv.org/pdf/2506.09212
