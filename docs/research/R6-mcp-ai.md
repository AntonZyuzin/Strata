# R6. MCP-сервер Strata и встроенные AI-функции

> Дата исследования: 2026-10-13. Версии пакетов сняты в этот день из npm registry и crates.io API. Тексты спецификации MCP, README и LICENSE читались из GitHub (raw). Документация Claude Code, Claude API и статьи поддержки Anthropic читались напрямую. Сайты modelcontextprotocol.io, developers.openai.com, ai.google.dev, huggingface.co, cursor.com и sqlite.org из среды исследования не открывались. Сведения о них взяты из выдачи поиска и помечены «по данным поиска». Всё, что проверить не удалось, помечено «не проверено».
>
> Обозначения: ✅ решено ответами владельца (ссылка на вопрос), 💡 предложение, ❓ вопрос. Термины — по [глоссарию](../glossary.md), модель данных — [05-domain-model.md](../05-domain-model.md).

## Кратко

- **Спецификация MCP сменилась летом 2026 года.** Текущая ревизия — `2026-07-28`. Протокол стал stateless: нет `initialize` и `Mcp-Session-Id`, появились `server/discover` и Multi Round-Trip Requests (MRTR) вместо запросов от сервера к клиенту. Sampling, Roots и Logging объявлены устаревшими, HTTP+SSE тоже, DCR уступил место Client ID Metadata Documents (CIMD). Клиенты в переходном состоянии: Claude Code уже умеет `2026-07-28`, про Codex и Claude Desktop это не проверено. Поэтому **сервер Strata должен быть «двухэпохальным»**: `2025-11-25` + `2026-07-28`. Rust SDK `rmcp` 3.5.1 (Apache-2.0) так и работает.
- **Архитектура: одно Rust-ядро, два входа.** Локально — `strata mcp` (stdio) из того же бинарника. Удалённо — эндпоинт `/mcp` (Streamable HTTP) на self-hosted сервере. Stdio-вход обязателен: Claude Desktop в `claude_desktop_config.json` принимает только локальные stdio-серверы, а его custom connectors ходят к серверу из облака Anthropic и не видят `localhost` и LAN. Поэтому тот же `strata mcp --remote …` служит мостом к командному серверу в локальной сети.
- **Инструменты: 26 в MVP и 28 в полном наборе, в трёх группах — чтение, запись, разрушающие.** Аннотации `readOnlyHint`/`destructiveHint`/`idempotentHint` нужны обязательно. По ним Codex решает, спрашивать ли подтверждение (режим `writes`), и запускает read-only инструменты параллельно. Ответы короткие по умолчанию, с курсорами пагинации. В них человекочитаемые пути рядом с ID. Ответ укладывается в лимит Claude Code: 25 000 токенов, предупреждение с 10 000.
- **Права: токены со скоупами, мягкое удаление, журнал и откат.** Скоупы `read` / `write` / `delete`, ограничение поддеревом сетей, уважение флага «Замок». Агент — отдельный пир с `origin=mcp:<клиент>` (см. R3). Каждый вызов записи — это changeset в журнале агента, который откатывается одной командой. Массовые операции идут через предпросмотр и подтверждение.
- **Картинки.** У Anthropic нет генерации изображений (✅ статья поддержки от 2026-03-16). Агент не может надёжно передать картинку через аргументы инструмента в base64: модели приходится «перепечатывать» байты. Отсюда паттерн «тикет загрузки»: инструмент выдаёт одноразовый URL, агент делает `PUT` файла через `curl`, затем вызывает `add_to_board(asset_id)`. Локально хватает пути к файлу. Для Claude Desktop, где нет shell, нужен собственный инструмент Strata `generate_image` с ключом пользователя. Провайдеры: OpenAI `gpt-image-2`/`2.5`, Google `gemini-nano-banana-2.1`, FLUX.2, Recraft (SVG), локальный ComfyUI.
- **Поиск по смыслу — гибридный и локальный.** tantivy (BM25 с русским стеммером) плюс векторы в той же SQLite-проекции через `sqlite-vec` 0.1.9 и слияние RRF. Эмбеддинги считаем через `fastembed` 7.1.1 (Rust, ONNX). Кандидаты на модель по умолчанию: **bge-m3** (MIT, 8192 токена, есть в fastembed через ONNX), **Qwen3-Embedding-0.6B** (Apache-2.0) и **EmbeddingGemma 2** (Apache-2.0, мультимодальная, вышла 2026-10-06). Выбор — спайком на реальном русском vault. Лёгкий пресет — multilingual-e5-small (MIT). EmbeddingGemma первой версии (Gemma Terms of Use) в поставку не кладём.
- **«Разобрать текст в ноды» — одна доменная операция `apply_graph_plan` с предпросмотром.** У неё два вызывающих. Первый — внешний агент по MCP: LLM — сам агент, sampling не нужен и уже устарел. Второй — кнопка в приложении: LLM по ключу пользователя (Anthropic, OpenAI) или Ollama. План — плоский список нод с временными ID и `parent`: structured outputs Claude не поддерживают рекурсивные схемы.
- **Дорожная карта AI.** MVP: локальный MCP (чтение, запись, `apply_graph_plan`, журнал и откат) плюс полнотекст. Этап 2: семантический поиск, «Разобрать в ноды» в приложении, генерация картинок на досках. Этап 3: удалённый MCP с OAuth 2.1, лента действий агентов, AI-справки для 3D, подсказки связей, MCP Apps.

## Находки

### 1. Спецификация MCP: версии, примитивы, транспорты, авторизация

#### 1.1. Ревизии

| Ревизия | Что важно для Strata | Источник |
|---|---|---|
| `2025-06-18` | Убран JSON-RPC batching. Добавлены structured tool output (`outputSchema` + `structuredContent`), elicitation, `resource_link` в результатах инструментов, поле `title`. MCP-сервер стал OAuth Resource Server с Protected Resource Metadata. RFC 8707 (resource indicators) для клиентов обязателен. Заголовок `MCP-Protocol-Version` обязателен | [changelog 2025-06-18](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/changelog.mdx) |
| `2025-11-25` | Иконки у инструментов, ресурсов и промптов (SEP-973). Инкрементальное согласие скоупов через `WWW-Authenticate` (SEP-835). Правила имён инструментов (SEP-986). URL-режим elicitation (SEP-1036). Tool calling внутри sampling (SEP-1577). CIMD рекомендован (SEP-991). Экспериментальные tasks (SEP-1686). Ошибки валидации входа возвращаются как ошибки выполнения, чтобы модель могла исправиться (SEP-1303). JSON Schema 2020-12 по умолчанию | [changelog 2025-11-25](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/changelog.mdx) |
| **`2026-07-28`** (текущая, `LATEST_PROTOCOL_VERSION`) | Stateless-ядро: нет `initialize`, нет `Mcp-Session-Id`, версия и возможности клиента передаются в `_meta` каждого запроса (SEP-2567, SEP-2575). Обязательный `server/discover`. `subscriptions/listen` вместо GET-потока и `resources/subscribe`. MRTR: сервер возвращает `resultType: "input_required"`, клиент повторяет запрос с `inputResponses` (SEP-2322). Tasks вынесены в расширение `io.modelcontextprotocol/tasks`. Списки кэшируются (`ttlMs`, `cacheScope`). Заголовки `Mcp-Method` и `Mcp-Name` на HTTP. Устарели Roots, Sampling, Logging (SEP-2577), HTTP+SSE и DCR. Минимальный срок жизни устаревшего — 12 месяцев (SEP-2596) | [changelog 2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx), [блог релиза](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts) |

**Совместимость эпох.** «Двухэпохальный» сервер по `initialize` переключается на старую семантику для данного stdio-процесса или HTTP-сессии. Запросы с `_meta` он обслуживает по правилам `2026-07-28` и может делать то и другое одновременно на одном эндпоинте. Сервер, который знает только новую ревизию, ломает старых клиентов: на `initialize` он отвечает ошибкой ([versioning.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/versioning.mdx)). **Вывод для Strata:** обязательно поддерживаем обе ревизии, пока все целевые клиенты не перейдут на новую.

**Следствие stateless-модели.** Состояние между вызовами передаётся явными хэндлами в аргументах инструментов, а не сессией ([блог релиза](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). Strata это подходит: инструменты принимают ID и пути, а длинные операции (импорт, генерация, переиндексация) возвращают `job_id`.

#### 1.2. Примитивы и их статус

| Примитив | Статус на `2026-07-28` | Как используем в Strata |
|---|---|---|
| Tools | Основной. `outputSchema`/`structuredContent` — любая JSON Schema 2020-12. Порядок в `tools/list` рекомендован детерминированным. Набор инструментов **может зависеть от авторизации запроса**, но не от соединения ([tools.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx)) | Основной интерфейс. Токен «только чтение» видит только инструменты чтения |
| Resources + templates | Основной. `resource_link` в результатах инструментов | `strata://node/{id}` для @-упоминаний в Claude Code, ассеты по хешу |
| Prompts | Основной. В Claude Code становятся командами `/mcp__strata__<prompt>` ([Claude Code MCP](https://code.claude.com/docs/en/mcp)) | Готовые сценарии: «разобрать текст», «недельный обзор» |
| Elicitation (form, URL) | Работает через MRTR | Подтверждение массовых операций там, где клиент поддерживает |
| Sampling | **Deprecated** (SEP-2577), рекомендуют прямые API провайдеров | Не используем |
| Roots, Logging | Deprecated | Не используем. Логи — stderr и OpenTelemetry |
| Tasks | Расширение `io.modelcontextprotocol/tasks` (опрос `tasks/get`) | 💡 Позже. В MVP — свой `job_id` + `get_job` |
| Icons | С `2025-11-25` | Пиксельная иконка Strata у сервера и инструментов |
| MCP Apps (`ui://`, `text/html;profile=mcp-app`) | Расширение (SEP-1865, Final). По данным поиска, поддерживается в Claude (веб и десктоп), ChatGPT, VS Code. Список хостов не проверен ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp), по данным поиска) | 💡 Этап 3: мини-холст сети прямо в чате Claude |

Типы контента в результате инструмента: `text`, `image` (base64 + `mimeType`), `audio`, `resource_link`, `resource` (встроенный). Если есть `structuredContent`, сервер **SHOULD** продублировать его сериализованным JSON в `text` ([tools.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx)).

#### 1.3. Аннотации инструментов (`ToolAnnotations`)

| Поле | Смысл | По умолчанию |
|---|---|---|
| `readOnlyHint` | Не меняет окружение | `false` |
| `destructiveHint` | Может делать разрушающие изменения; `false` — только добавляющие. Имеет смысл при `readOnlyHint == false` | `true` |
| `idempotentHint` | Повторный вызов с теми же аргументами ничего не меняет | `false` |
| `openWorldHint` | Взаимодействует с внешним «открытым миром» | `true` |

Все поля — подсказки. Клиент не должен принимать решения по аннотациям от недоверенных серверов ([schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)). Из умолчаний следует: **инструмент без аннотаций считается разрушающим и «открытым»**. Поэтому Strata проставляет все четыре поля явно.

#### 1.4. Транспорты

| Транспорт | Правила | Источник |
|---|---|---|
| stdio | Клиент запускает сервер подпроцессом. JSON-RPC построчно. В stdout только сообщения MCP, логи — в stderr. Новый клиент сначала пробует `server/discover` и при неудаче откатывается на `initialize` | [stdio.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/stdio.mdx) |
| Streamable HTTP | Один эндпоинт, каждый запрос — отдельный POST. Ответ — JSON или SSE-поток на этот запрос. Обязательные заголовки: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (для `tools/call`, `resources/read`, `prompts/get`). GET-эндпоинт и сессии убраны | [streamable-http.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx) |
| HTTP+SSE (2024-11-05) | Deprecated. В `rmcp` намеренно не реализован | [changelog](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx), [rmcp README](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/README.md) |

Требования безопасности к HTTP: «Servers MUST validate the Origin header on all incoming connections to prevent DNS rebinding attacks»; локальный сервер SHOULD слушать только `127.0.0.1`; SHOULD требовать аутентификацию ([streamable-http.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)).

#### 1.5. Авторизация удалённого сервера

- Авторизация опциональна. Для HTTP она SHOULD следовать спецификации, для stdio учётные данные берутся из окружения ([authorization/index.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/index.mdx)).
- Сервер MUST реализовать **OAuth 2.0 Protected Resource Metadata (RFC 9728)**. Ответ 401 с `WWW-Authenticate` указывает на `/.well-known/oauth-protected-resource`. Authorization server — OAuth 2.1 с RFC 8414 или OIDC Discovery.
- Клиент MUST отправлять `resource` (RFC 8707). Сервер MUST проверять аудиторию токена и MUST NOT пропускать токен дальше (token passthrough).
- Нехватка прав — 403 `insufficient_scope` со всеми нужными скоупами. Клиент проходит step-up авторизацию.
- Регистрация клиентов в порядке приоритета: заранее выданные данные → **CIMD** (`client_id` — HTTPS-URL с JSON-метаданными) → DCR (deprecated) → ручной ввод. Для нативных и CLI-клиентов `application_type: "native"` ([client-registration.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/client-registration.mdx)).
- PKCE (S256) обязателен. Redirect URI — только `localhost` или HTTPS. Access-токены короткоживущие, refresh-токены публичных клиентов ротируются ([security-considerations.mdx](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx)).

#### 1.6. Официальные SDK

| SDK | Версия на 2026-10-13 | Лицензия | Состояние |
|---|---|---|---|
| TypeScript v2: `@modelcontextprotocol/server`, `@modelcontextprotocol/client` | 2.3.1 (2026-10-05); 2.0.0 — 2026-07-27 | Apache-2.0 для нового кода, существующий код под MIT | Стабильная линия, реализует `2026-07-28`. Node, Bun, Deno. Адаптеры `@modelcontextprotocol/express`, `fastify`, `hono`, `node`. Схемы через Standard Schema (Zod v4, Valibot, ArkType) ([README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md), npm) |
| TypeScript v1: `@modelcontextprotocol/sdk` | 1.32.1 (2026-10-05) | MIT (npm) | Только исправления, минимум 6 месяцев после выхода v2 ([README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)) |
| Rust: `rmcp` | 3.5.1 (2026-10-05) | Apache-2.0 (crates.io; репозиторий в переходе MIT → Apache-2.0, [LICENSE](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/LICENSE)) | Реализует `2026-07-28`, совместим с `2025-11-25` и ранее. Транспорты: stdio, Streamable HTTP-сервер (Tower), HTTP-клиент (reqwest), child process. OAuth — только клиентская сторона ([README](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/README.md), [OAUTH_SUPPORT.md](https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/docs/OAUTH_SUPPORT.md)). Блог релиза называл поддержку новой ревизии в Rust SDK бетой; README уже называет её стабильной |
| MCP Inspector | 2.10.1 (2026-10-08) | «SEE LICENSE IN LICENSE» (npm, не проверено) | Отладка сервера |

Темп `rmcp`: 1.0.0 — 2026-03-03, 2.0.0 — 2026-06-29, 3.0.0 — 2026-07-28. С 3.0.0 по 3.5.1 вышло 12 релизов за 10 недель (crates.io). Три мажорные версии за полгода — риск, это нужно учесть при закреплении версий.

Tier 1 SDK на момент выхода `2026-07-28`: TypeScript, Python, Go, C# ([блог релиза](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

### 2. Клиенты: как подключают MCP-серверы сегодня

#### 2.1. Claude Code (2.1.296 от 2026-10-09, npm)

Команды ([Claude Code MCP](https://code.claude.com/docs/en/mcp)):

```bash
# локальный stdio-сервер; всё после «--» — команда сервера
claude mcp add --scope user strata -- strata mcp --workspace ~/Strata/Main

# удалённый Streamable HTTP с токеном
claude mcp add --transport http --scope user strata-team https://strata.example.lan/mcp \
  --header "Authorization: Bearer ${STRATA_TOKEN}"

claude mcp login strata-team     # OAuth из shell; внутри сессии — /mcp
claude mcp list | get | remove
```

| Скоуп | Где хранится | Делится |
|---|---|---|
| `local` (по умолчанию) | `~/.claude.json` под путём проекта | Нет |
| `project` | `.mcp.json` в корне проекта | Да, через git; требует одобрения при первом запуске |
| `user` | `~/.claude.json` | Нет, но доступен во всех проектах |

Что важно для автора сервера ([Claude Code MCP](https://code.claude.com/docs/en/mcp)):

- `.mcp.json` поддерживает `${VAR}` и `${VAR:-default}` в `command`, `args`, `env`, `url`, `headers`. Динамические заголовки задаются через `headersHelper`.
- **Лимиты вывода.** Предупреждение — с 10 000 токенов, максимум по умолчанию — 25 000 (`MAX_MCP_OUTPUT_TOKENS`). Текст длиннее 50 000 символов уходит в файл. Порог для отдельного инструмента поднимается через `_meta["anthropic/maxResultSizeChars"]`, потолок — 500 000 символов. Ответ HTTP больше 16 МБ отклоняется.
- **Картинки** PNG, JPEG, GIF и WebP в результатах инструментов модель видит inline. Оригинал сохраняется в `tool-results`.
- **Tool search включён по умолчанию.** На старте грузятся только имена инструментов и `instructions` сервера, описания подтягиваются по требованию. Описания и instructions обрезаются до 2048 символов. `_meta["anthropic/alwaysLoad"]: true` грузит инструмент сразу.
- `_meta["anthropic/requiresUserInteraction"]: true` — подтверждение на каждый вызов, даже в режимах auto и bypass. Годится для самых опасных инструментов.
- Elicitation поддерживается в режимах form и URL. На `2026-07-28` клиент объявляет `elicitation: {form: {}, url: {}}`.
- Два рантайма: v1 на TS SDK 1.x и v2 на TS SDK 2.0 с ревизией `2026-07-28`. Переключение — через `MCP_SDK_GENERATION`, `MCP_PROTOCOL_NEGOTIATION=auto|legacy`.
- Вызов дольше 2 минут автоматически уходит в фон. Таймаут простоя: 30 минут для stdio, 5 минут для HTTP.
- Корневые `anyOf`/`oneOf`/`allOf` в `inputSchema` Claude Code «сплющивает». Имена свойств — 1–64 символа `[A-Za-z0-9_.-]`. **Вывод:** входные схемы делаем плоскими объектами.

#### 2.2. Claude Desktop

- **Локальные серверы — через `claude_desktop_config.json`** с ключом `mcpServers` (`command`, `args`, `env`). Пути по сторонним источникам (официальная страница не открылась): macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows — `%APPDATA%\Claude\claude_desktop_config.json` ([пример](https://docs.timbr.ai/doc/docs/integration/mcp/claude), по данным поиска). Путь на Linux не проверен.
- **В этом файле не работают записи с `url`/`type: "http"`.** По нескольким сторонним источникам, они молча отбрасываются. Стандартный обход — stdio-мост `npx mcp-remote <url>` ([startdebugging.net](https://startdebugging.net/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/), [GitHub issue](https://github.com/anthropics/claude-code/issues/37286), по данным поиска).
- **Удалённые серверы — через Custom connectors**: Customize → Connectors → Add custom connector. Поддерживаются OAuth (включая «Use Claude's published identity», «Register automatically», свой клиент) и статические заголовки. **Подключение идёт из облака Anthropic**: «Claude connects to your remote MCP server from Anthropic's cloud infrastructure, rather than from your local device». Значит, сервер должен быть доступен из интернета с IP-диапазонов Anthropic ([статья поддержки](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).
- **Desktop extensions `.mcpb`** (бывшие `.dxt`, старые файлы работают) — zip с `manifest.json` и локальным stdio-сервером. Ставятся двойным кликом или через Settings → Extensions → Advanced settings → Install Extension… CLI: `npm install -g @anthropic-ai/mcpb` (2.1.2, MIT), затем `mcpb init`, `mcpb pack`. Каталог больше не принимает MCPB: локальные серверы распространяются через плагины или напрямую ([Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb)). Манифест версии `0.3` поддерживает `server.type: "binary"`, `platform_overrides`, `${__dirname}` и `user_config` (типы `directory`, `string` с `sensitive: true`). Платформы — `darwin`, `win32`, `linux` ([MANIFEST.md](https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/MANIFEST.md)).
- **Платформы.** Документация MCPB называет macOS и Windows. Официальная бета для Linux (Ubuntu 22.04+, Debian 12+) вышла 2026-06-30 ([itbrief](https://itbrief.co.uk/story/anthropic-launches-claude-desktop-beta-for-linux-users), по данным поиска; на сайте Anthropic не проверено). Arch Linux (omarchy) официально не поддерживается — не проверено.

Пример (💡) — ручная настройка, если не ставить `.mcpb`:

```json
{
  "mcpServers": {
    "strata": {
      "command": "/Applications/Strata.app/Contents/MacOS/strata",
      "args": ["mcp", "--workspace", "/Users/me/Strata/Main"]
    },
    "strata-team": {
      "command": "/Applications/Strata.app/Contents/MacOS/strata",
      "args": ["mcp", "--remote", "https://strata.example.lan/mcp"],
      "env": { "STRATA_TOKEN": "…" }
    }
  }
}
```

#### 2.3. OpenAI Codex CLI (0.162.1, npm; лицензия Apache-2.0)

Серверы описываются в `~/.codex/config.toml` таблицами `[mcp_servers.<имя>]`. Проектный `.codex/config.toml` работает в доверенных проектах. HTTP-транспорт включается полем `url`. Официальные страницы developers.openai.com из среды не открылись, поэтому формат взят из выдачи поиска по [Configuration Reference](https://developers.openai.com/codex/config-reference) и [Codex MCP](https://developers.openai.com/codex/mcp) и сторонних гайдов ([tembo.io](https://www.tembo.io/blog/codex-cli-mcp), [unwait.ai](https://unwait.ai/blog/codex-mcp)):

```toml
[mcp_servers.strata]
command = "strata"
args = ["mcp", "--workspace", "/home/me/Strata/Main"]
startup_timeout_sec = 20                 # по умолчанию 10 с
tool_timeout_sec = 120                   # по умолчанию 60 с
default_tools_approval_mode = "writes"   # auto | prompt | writes | approve

[mcp_servers.strata-team]
url = "https://strata.example.lan/mcp"   # Streamable HTTP
bearer_token_env_var = "STRATA_TOKEN"    # секрет не хранится в файле
# http_headers = { … }, env_http_headers = { … }, enabled_tools = [ … ], disabled_tools = [ … ]
```

- CLI: `codex mcp add <имя> --url <url> --bearer-token-env-var <VAR>`, `codex mcp list | get | remove | login`. OAuth и Streamable HTTP идут через Rust-клиент на `rmcp` ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/05/19/codex-cli-mcp-server-management-cli-commands-oauth-streamable-http-production-patterns/), по данным поиска).
- **Аннотации влияют на подтверждения.** В режиме `writes` (по сторонним данным, появился в 0.144.0) Codex не спрашивает подтверждения у инструментов, объявивших `readOnlyHint: true`. Инструменты без аннотаций считаются записывающими и в неинтерактивном режиме блокируются ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/07/20/writes-mode-permission-primitive-codex-cli-approval-least-privilege/), [issue в стороннем проекте](https://github.com/gwicho38/mitodo/issues/10), по данным поиска). С v0.136 read-only инструменты выполняются параллельно ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/06/03/codex-cli-mcp-v0136-per-server-env-targeting-oauth-streamable-http-concurrent-tools/), по данным поиска).
- Картинки из MCP-результатов модель видит. Это реализовано в PR #5600 и исправлено в #9815 (по данным поиска; на официальной документации не проверено).
- В Codex встроена генерация картинок (`image_gen`, по умолчанию `gpt-image-2`). Результат — файл на диске ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/), по данным поиска).
- Поддерживает ли Codex ревизию `2026-07-28` — не проверено.

#### 2.4. Cursor (коротко)

`.cursor/mcp.json` в проекте и глобальный файл. Формат — тот же `mcpServers` с `command`/`args`/`env` для stdio и `url`/`headers` для удалённых. Для удалённых серверов есть OAuth через discovery и статический OAuth (`auth` с client id/secret) ([truefoundry](https://www.truefoundry.com/blog/mcp-authentication-in-cursor-oauth-api-keys-and-secure-configuration), [pipeshub](https://docs.pipeshub.com/mcp/cursor), по данным поиска). Путь глобального файла (`~/.cursor/mcp.json`) и текущий набор возможностей не проверены: cursor.com из среды не открылся.

#### 2.5. Может ли десктоп-приложение быть локальным MCP-сервером

| Вариант | Claude Code | Claude Desktop | Codex | Cursor | Минусы |
|---|---|---|---|---|---|
| **stdio-лаунчер** (`strata mcp` — тот же бинарник, клиент запускает его сам) | ✓ | ✓ (единственный штатный путь; `.mcpb`) | ✓ | ✓ | Нужен доступ к пространству из отдельного процесса: либо IPC к запущенному ядру, либо открыть пространство самому |
| **Локальный HTTP** `http://127.0.0.1:<port>/mcp` внутри работающего приложения | ✓ (`--transport http`) | ✗ (url в конфиге не принимается; custom connector не видит localhost) — только через мост | ✓ (`url`) | ✓ | Работает, только пока приложение открыто. Нужны Origin-проверка, токен, привязка к 127.0.0.1. Риск DNS rebinding |
| Custom connector (облако → сервер) | — | ✓, только для публичного HTTPS | — | — | Self-hosted сервер в LAN недоступен |

**Вывод.** Основной путь — stdio-лаунчер. Это тонкий процесс: он подключается к ядру Strata по локальному сокету (Unix socket или Windows named pipe). Если ядро не запущено, он поднимает его без окна. Тот же лаунчер с флагом `--remote` проксирует stdio ↔ Streamable HTTP на командный сервер. Так Claude Desktop получает доступ к серверу в LAN без `npx mcp-remote` и без Node.js. Локальный HTTP — опция для Cursor и Claude Code, по умолчанию выключена.

### 3. Практики проектирования инструментов

Из руководства Anthropic «Writing effective tools for agents» (2025-09-11, [anthropic.com](https://www.anthropic.com/engineering/writing-tools-for-agents)), спецификации и документации клиентов:

| Практика | Суть | Для Strata |
|---|---|---|
| Мало сильных инструментов | «More tools don't always lead to better outcomes». Многошаговые операции лучше объединять в одну | Не делаем по инструменту на каждую CRUD-ручку. `apply_graph_plan` вместо 30 вызовов `create_node` |
| Неймспейсы | Префикс по сервису или ресурсу. Claude Code сам добавляет `mcp__<сервер>__` | Имена `глагол_существительное`, сервер называется `strata` |
| Осмысленный контекст | Человекочитаемые имена вместо голых UUID. Enum `response_format: concise \| detailed` | В каждой строке ответа `name`, `path`, `id`. Принимаем на вход ID **или** путь |
| Токен-эффективность | Пагинация, фильтры, усечение с разумными умолчаниями. В Claude Code 25 000 токенов по умолчанию | `limit` по умолчанию 20, курсоры `next_cursor`, сниппеты по 200 символов, `max_chars` у содержимого |
| Ошибки, по которым можно исправиться | Конкретная подсказка вместо трейсбэка. Ошибки валидации — как `isError: true` (SEP-1303) | «Найдено 3 ноды с именем „Референсы“: …, укажите `id` или путь» |
| Описания как для нового сотрудника | Однозначные имена параметров, строгие схемы. В Claude Code описания до 2048 символов | Короткие описания, критичное — в начале. Подробности — в `instructions` сервера |
| Аннотации | Все четыре явно (§1.3) | Таблицы §4 |
| Идемпотентность | `idempotentHint` + ключ идемпотентности | Детерминированные ID нитей (05 §8.1) уже дают идемпотентный `connect`. Для `create_*` — `client_request_id` |
| Детерминированный порядок `tools/list` | SHOULD в `2026-07-28`. Помогает кэшу промптов | Фиксированный порядок |
| Картинки наружу | `ImageContent` (base64) | Миниатюры ≤ 1568 px по длинной стороне (💡 порог), оригинал — через `resource_link` |
| **Бинарные данные внутрь** | Base64 в аргументах модель «перепечатывает». Пример: PNG на 3 232 байта дошёл битым, хотя все слои сообщили об успехе ([blog.jztan.com](https://blog.jztan.com/mcp-file-upload-base64-corruption/)). Стандарта загрузки файлов в MCP нет, рабочая группа ещё работает ([sunpeak.ai](https://sunpeak.ai/blogs/file-uploads-mcp-apps), по данным поиска) | Тикет загрузки (одноразовый `PUT`-URL) или локальный путь. Base64 — только для мелочи до ~64 КБ с проверкой SHA-256 |
| Долгие операции | Хэндлы в аргументах; расширение tasks | `job_id` + `get_job` |
| Prompt injection | «Смертельная триада»: доступ к приватным данным + недоверенный контент + канал наружу ([Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)) | Содержимое нод в ответах — данные, а не инструкции. Strata сама не ходит в сеть, кроме явно разрешённой генерации картинок. Режим «только чтение» для экспериментов |

### 4. Предлагаемый интерфейс MCP Strata (💡)

#### 4.1. Принципы

1. **Один набор доменных операций.** MCP, UI и импорт вызывают одни и те же команды ядра. Запись идёт CRDT-коммитом с `origin=mcp:<клиент>` и понятным сообщением (R3 §8). Сам MCP-слой бизнес-логики не содержит.
2. **Ноды адресуются так:** `node` = ID (UUIDv7) **или** канонический путь `/Проекты/Игра/Задача`. Если путь неоднозначен — ошибка со списком кандидатов.
3. **Ответы по умолчанию — `concise`.** Это компактный текст (Markdown-таблица или строки) плюс `structuredContent` для клиентов, которые его читают. `detailed` добавляет атрибуты, превью и счётчики.
4. **Граница ленивой загрузки (N1).** Инструменты поиска и навигации работают по индексу пространства и SQLite-проекции, содержимое не грузят. Документ содержимого читается только в `get_node(include: content)`.
5. **Набор зависит от прав токена.** Токен `read` получает только инструменты чтения. Спецификация это разрешает (§1.2).

#### 4.2. Инструменты чтения (`readOnlyHint: true`, `openWorldHint: false`)

| Инструмент | Что делает | Ключевые параметры | Ответ |
|---|---|---|---|
| `get_workspace` | Схема пространства: статусы, атрибуты, классы, люди, корневые сети, возможности (есть ли семантический поиск, генерация) | — | Короткая справка. Нужна агенту, чтобы писать валидные значения |
| `search_nodes` | Нечёткий поиск по **именам** и путям — тот же движок, что в Tab-меню (✅ G1) | `query`, `kind?`, `class?`, `within?` (сеть-поддерево), `limit=20`, `cursor` | `name`, `kind`, `path`, `status`, `deadline`, `id` |
| `query_nodes` | Фильтр по атрибутам: статус, дедлайн (диапазон, просрочено), ответственные, теги, флаги; сортировка | `filter`, `sort`, `within?`, `limit`, `cursor` | То же + свёртки для сетей |
| `search_content` | Поиск по содержимому: полнотекст (BM25) + по смыслу (векторы), слияние RRF | `query`, `mode=auto\|keyword\|semantic`, `within?`, `kinds?`, `limit=10` | Чанки: нода, путь, сниппет с подсветкой, скор |
| `get_node` | Нода целиком | `node`, `include=[attributes, content, edges, placements]`, `max_chars=8000`, `offset` | Заметка — Markdown. Список — пункты. Доска — сводка элементов и `resource_link` на картинки. Сеть — краткий состав. Медиа — метаданные + `resource_link` |
| `list_network` | Содержимое сети: ноды, рамки, стикеры; при `depth>1` — дерево-оглавление | `network`, `depth=1..3`, `with_layout=false`, `limit`, `cursor` | Строки нод, рамки со списками участников |
| `get_neighbors` | Нити ноды и обход выше и ниже по течению | `node`, `direction=in\|out\|both`, `depth=1..3`, `scope=global\|network`, `limit` | Список нод с направлением и расстоянием |
| `get_paths` | Все размещения ноды и их пути, основной первым | `node` | Пути с отметкой основного |
| `get_image` | Картинка ассета или медиа-ноды для «зрения» агента | `asset` или `node`, `max_px=1568` | `ImageContent` (миниатюра) + `resource_link` на оригинал |
| `get_ui_context` | Только локально: что открыто в окне Strata — текущая сеть, выделение, нода в фокусе | — | Даёт агенту понять «вот эта сеть» |
| `get_job` | Статус фоновой операции | `job_id` | Прогресс, результат или ошибка |

#### 4.3. Инструменты записи (`readOnlyHint: false`, `destructiveHint: false`)

| Инструмент | Что делает | `idempotentHint` | Заметки |
|---|---|---|---|
| `create_node` | Новая нода с основным размещением | `true` при `client_request_id` | `kind`, `name`, `network`, `class?`, `attributes?`, `icon?`, `content?` (Markdown или пункты), `position?` (иначе автораскладка рядом с соседями) |
| `update_node` | Имя, иконка, цвет, сводка, атрибуты (статус, дедлайн, ответственные, теги, свои поля), флаги кроме «Замка» | `true` | Частичный патч |
| `edit_note` | Правка текста заметки операциями: `append`, `prepend`, `replace_section` (по заголовку), `str_replace` (уникальный фрагмент), `replace_all` с `expected_hash` | `false` | Не затирает параллельную правку человека: операции ложатся в CRDT-текст (`LoroText`, R3). `[[ссылки]]` создают нити автоматически (✅ C8) |
| `edit_checklist` | Добавить, отметить, снять, переставить пункты | `false` | |
| `place_node` | Появление существующей ноды в другой сети («Разместить здесь») | `true` | Проверка ацикличности вложенности (05 §5) |
| `move_node` | Перенести размещение в другую сеть | `true` | Меняет пути; ID не меняется |
| `connect` | Создать нити (пакетом) | `true` | ID нити — хеш пары, повтор безвреден |
| `insert_into_edge` | Вставить ноду X в нить A → B (как «бросить на нить» в Houdini) | `true` | Одна отменяемая операция (05 §8.4) |
| `apply_graph_plan` | Пакет: ноды, размещения, нити, содержимое из плоского плана с временными ID. `dry_run=true` возвращает предпросмотр и дифф | `true` при `client_request_id` | Основа «Разобрать текст в ноды» и импорта. Лимит нод на вызов — 💡 200 |
| `add_to_board` | Положить на доску картинку (`asset_id` \| `url` \| локальный `path`), короткую заметку или to-do виджет | `false` | `url` скачивает сервер; `path` — только локально и в разрешённых каталогах |
| `create_asset_upload` | Выдать одноразовый `PUT`-URL и `asset_id` для файла | `false` | Тикет на 10 минут, лимит размера, SHA-256 в ответе загрузки |
| `import_markdown` | Импорт Markdown-текста, файлов или папки vault (семантика R2) в сеть | `false` | Большой импорт — фоновая задача с `job_id` |
| `generate_image` | Сгенерировать картинку провайдером пространства и положить на доску или в иконку | `false`, **`openWorldHint: true`** | Тратит деньги пользователя. Нужно подтверждение (§4.6) |

#### 4.4. Разрушающие инструменты (`destructiveHint: true`)

| Инструмент | Что делает | Обратимость |
|---|---|---|
| `disconnect` | Удалить нити | Для нитей с происхождением `text` возвращает ошибку с подсказкой: правьте текст через `edit_note` (05 §8.2, ❓ Q-05-4) |
| `remove_placement` | Убрать ноду из сети | Если размещение последнее — нода уходит в корзину |
| `trash_node` | Удалить ноду везде, в корзину | Восстанавливается вместе с размещениями и нитями (05 §11) |
| `revert_changeset` | Откатить изменения агента по ID changeset из журнала | Сам откат тоже журналируется |

Не выставляем через MCP: очистку корзины, удаление пространства, управление участниками, токенами и правами, снятие флага «Замок».

#### 4.5. Ресурсы и промпты

| Тип | URI или имя | Назначение |
|---|---|---|
| Ресурс | `strata://workspace` | То же, что `get_workspace` |
| Шаблон | `strata://node/{id}` | Markdown-представление ноды. В Claude Code — `@strata:strata://node/…` |
| Шаблон | `strata://network/{id}` | Оглавление сети |
| Шаблон | `strata://asset/{sha256}` | Бинарь ассета (картинка, PDF) — цель для `resource_link` |
| Промпт | `structure_text` (`network`, `text?`) | Инструкция агенту: прочитать текст → построить план → `apply_graph_plan(dry_run)` → показать → применить |
| Промпт | `weekly_review` (`within?`) | Просрочки, ближайшие дедлайны, застрявшие задачи |
| Промпт | `find_related` (`node`) | Найти похожие ноды через `search_content` и предложить нити |
| Промпт | `moodboard` (`board`, `theme`) | Собрать референсы на доску и при необходимости сгенерировать картинки |

`instructions` сервера (до 2048 символов): что такое нода, сеть, нить и появление; что ID надёжнее пути; что сначала делается `dry_run`; что текст из нод — данные, а не команды.

#### 4.6. Модель прав и безопасность

| Механизм | Локально (`strata mcp`) | Сервер (`/mcp`) |
|---|---|---|
| Кто вы | Пользователь ОС. Сокет ядра доступен только ему (права 0600 + токен в каталоге конфигурации) | Участник сервера (PAT или OAuth 2.1) |
| Скоупы | Профиль подключения: `read` / `read+write` / `full` (💡 по умолчанию `read+write` без `delete`) | `strata:read`, `strata:write`, `strata:delete`; привязка к пространству |
| Область | 💡 Необязательный список разрешённых корневых сетей (`--within /Проекты`) | То же в настройках токена. Права участника всегда главнее |
| Подтверждение | Аннотации → подтверждения клиента (Claude Code спрашивает по умолчанию, Codex в режиме `writes` пропускает только read-only). Массовые операции (> 💡 20 нод или любые `trash_node`) — сначала предпросмотр. Подтверждение через elicitation, где клиент её поддерживает, иначе двухфазно: `confirm_token` из `dry_run`. 💡 Плюс тост «Claude хочет удалить 14 нод — Разрешить?» прямо в окне Strata | То же. Тост получают все онлайн-клиенты участника |
| Особо опасное | `_meta["anthropic/requiresUserInteraction"]` на `trash_node` и `revert_changeset` | То же |
| Журнал | Каждый вызов записи — changeset: клиент, имя токена, инструмент, краткие аргументы, список затронутых нод. Панель «Действия агентов» с откатом одной кнопкой | Серверный журнал; `userId` проставляет сервер (R3) |
| Откат | `revert_changeset` и UI. Внутри — обратные доменные операции или `revertTo` Loro (R3) | То же |
| Защита | Флаг «Замок» запрещает правку. Лимит частоты 💡 60 записей в минуту. Лимит нод на вызов. `path` в `add_to_board`/`import_markdown` — только в разрешённых каталогах | Плюс проверка аудитории токена, отказ от token passthrough, Origin-проверка |
| Стоимость | `generate_image` и LLM-функции — с лимитом расходов в настройках пространства | Лимит на пространство и на токен |

`clientInfo` и идентичность клиента в `_meta` клиент объявляет сам. Используем их только как подпись в журнале, не для прав.

#### 4.7. Пример короткого ответа `search_nodes`

```text
3 из 3 · «референсы»
- Референсы — доска · /Проекты/Игра/Референсы (+2 появления) · id 0192f3…a1
- Референсы звука — доска · /Проекты/Игра/Звук/Референсы звука · id 0192f4…07
- Референсы UI — заметка · /Архив/2025/Референсы UI · статус «Готово» · id 0191aa…3c
```

Рядом в `structuredContent` — массив объектов по `outputSchema`, `next_cursor: null`.

### 5. Встроенные AI-функции

✅ G1, K1: поиск по содержимому и смыслу идёт через AI и MCP, структуризация текстов и картинок, генерация картинок на холстах — «было бы здорово». ✅ G1: в Tab-меню и строке поиска — нечёткий поиск по **именам**, как в Houdini.

#### 5.1. Локальные мультиязычные модели эмбеддингов

| Модель | Размер | Измерения | Контекст | Лицензия | Рантаймы | Источник |
|---|---|---|---|---|---|---|
| **multilingual-e5-small** | ≈ 118 M (не проверено) | 384 | 512 | MIT (по карточке HF, по данным поиска) | fastembed-rs (ONNX), transformers.js | [promptlayer](https://www.promptlayer.com/models/multilingual-e5-small), [fastembed-rs](https://raw.githubusercontent.com/Anush008/fastembed-rs/main/README.md) |
| multilingual-e5-base / large | — | 768 / 1024 | 512 | MIT (не проверено) | fastembed-rs | fastembed-rs |
| **bge-m3** | ≈ 568 M (XLM-R large, не проверено) | 1024 | 8192 | MIT ([LICENSE FlagEmbedding](https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE)) | fastembed-rs (dense **и** sparse; есть реранкер bge-reranker-v2-m3) | [README BGE-M3](https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/research/BGE_M3/README.md) |
| **Qwen3-Embedding-0.6B** | 0,6 B | 1024, MRL | 32K | Apache-2.0 (по зеркалам карточки, по данным поиска) | fastembed-rs (feature `qwen3`, через candle) | [README Qwen3-Embedding](https://raw.githubusercontent.com/QwenLM/Qwen3-Embedding/main/README.md): MMTEB multilingual Mean(Task) 64.33 |
| EmbeddingGemma (300m) | ≈ 300–308 M | 768, MRL 512/256/128 | 2048 | **Gemma Terms of Use**: ограничения использования, которые надо передавать дальше ([условия](https://ai.google.dev/gemma/terms), по данным поиска) | fastembed-rs, transformers.js (`onnx-community/embeddinggemma-300m-ONNX`, без fp16) | MMTEB multilingual v2 61.15 при 768d (карточка, по данным поиска) |
| **EmbeddingGemma 2** (2026-10-06) | 740 M всего; текст и код — 270 M, зрение +170 M, аудио +300 M (опциональны) | 768, MRL до 128 | 8192 | Apache-2.0 | По данным поиска: sentence-transformers ≥ 6.1, transformers.js, Ollama, llama.cpp, MLX, LiteRT. В fastembed-rs пока нет. ONNX не проверен | [MarkTechPost](https://www.marktechpost.com/2026/10/06/google-deepmind-releases-embeddinggemma-2-a-740m-open-multimodal-embedding-model-built-on-gemma-4/), [пост Google в X](https://x.com/Google/status/2107505117511528640), по данным поиска |
| snowflake-arctic-embed-l-v2.0 | 568 M (303 M без эмбеддингов) | 1024 | — | Apache-2.0 (по данным поиска) | В fastembed-rs только старые версии arctic | [zilliz](https://zilliz.com/ai-models/snowflake-arctic-embed-l-v2.0) |
| voyage-4-nano | — | 2048 (MRL до 256) | 32K | Apache-2.0, open-weight | Не проверено | [Anthropic: Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings) |

Качество на русском: есть бенчмарк ruMTEB (NAACL 2025, 23 задачи), но свежих сравнений этих моделей на нём найти не удалось ([ACL Anthology](https://aclanthology.org/2025.naacl-long.12/)). Есть русскоязычные модели (ru-en-RoSBERTa, GigaEmbeddings, USER-bge-m3), но их лицензии и пригодность не проверялись. **Вывод:** выбираем по своему замеру на реальном vault владельца (спайк, §рекомендация).

#### 5.2. Рантаймы

| Библиотека | Версия | Лицензия | Роль |
|---|---|---|---|
| `fastembed` (Rust) | 7.1.1 (2026-10-07) | Apache-2.0 | Готовые модели: e5, bge-m3 dense и sparse, EmbeddingGemma, Qwen3, nomic v2, реранкеры. Бэкенд — ONNX Runtime через `ort`, у Qwen3 и nomic v2 — candle ([README](https://raw.githubusercontent.com/Anush008/fastembed-rs/main/README.md)) |
| `ort` | 2.0.0-rc.14 (2026-10-12) | MIT OR Apache-2.0 | Всё ещё release candidate (crates.io) |
| `candle-core` / `candle-transformers` | 0.11.0 (2026-06-26) | MIT OR Apache-2.0 | Чистый Rust, без нативного ONNX Runtime |
| `@huggingface/transformers` (transformers.js) | 4.3.1 (2026-10-06) | Apache-2.0 | Браузер, Node, Bun, Deno; WebGPU-рантайм переписан в v4 (март 2026). Для BERT-подобных эмбеддингов до 4× быстрее, с 4.3 — WebGPU в Safari 26+ ([релизы](https://github.com/huggingface/transformers.js/releases), по данным поиска) |
| `onnxruntime-web` | 1.30.0 (2026-09-14) | MIT | Нижний слой transformers.js |

Для Strata эмбеддинги считает Rust-ядро: локально на десктопе, на сервере для командных пространств. Веб-клиент работает с сервером, поэтому браузерные эмбеддинги ему не нужны. transformers.js — запасной вариант для офлайн-веба.

#### 5.3. API-эмбеддинги по ключу пользователя

- У Anthropic своей модели эмбеддингов нет, рекомендуют Voyage AI: `voyage-4-large`, `voyage-4`, `voyage-4-lite` (32K, 1024 по умолчанию, MRL), мультимодальная `voyage-multimodal-3.5`, реранкер `rerank-3` ([Anthropic: Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings)).
- OpenAI: `text-embedding-3-small` и `-large` ([openai-node](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/embeddings.ts)). Цена, по агрегаторам, ≈ $0,02 и $0,13 за 1 M токенов ([aiapiprices](https://aiapiprices.com/embeddings-api-pricing/), по данным поиска).
- Google `gemini-embedding-2-preview` — ≈ $0,20 за 1 M (по агрегатору [tokencost](https://tokencost.app/blog/gemini-embedding-2-pricing), не проверено).
- Ollama: `POST /api/embed` ([api.md](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md)). Это локальный вариант без своего рантайма в Strata.

Минусы API: текст заметок уходит третьей стороне, при смене модели индекс пересчитывается. Плюс: сервер команды не тратит CPU.

#### 5.4. Векторный индекс

| Вариант | Версия, лицензия | Плюсы | Минусы |
|---|---|---|---|
| **`sqlite-vec`** | 0.1.9 стабильная (2026-03-31), 0.1.10-alpha.4 (2026-05-18); MIT OR Apache-2.0 ([LICENSE-MIT](https://raw.githubusercontent.com/asg017/sqlite-vec/main/LICENSE-MIT), crates.io) | Живёт в той же SQLite-проекции, что поиск, пути и 3D (R3, R4). Виртуальная таблица `vec0`: float, int8, бинарные векторы, метаданные и partition-ключи. Есть WASM. Спонсор — Mozilla Builders ([README](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md)) | Pre-v1, «expect breaking changes». В стабильной версии только полный перебор. ANN (DiskANN, IVF, rescore) — экспериментальные в alpha ([релизы](https://github.com/asg017/sqlite-vec/releases), по данным поиска) |
| `vec1` (команда SQLite) | ANN на IVFADC + OPQ; на 2026-03-30 «no release yet» | Официальное расширение SQLite | Не выпущен ([форум SQLite](https://sqlite.org/forum/forumpost/9fea7e0fbb6ddd2f), по данным поиска) |
| LanceDB | 0.40.0 (2026-10-07), Apache-2.0 | Колоночный формат Lance, встроенный FTS, гибридный поиск, Rust, Python, JS ([README](https://raw.githubusercontent.com/lancedb/lancedb/main/README.md)) | Вторая СУБД рядом с SQLite и tantivy, тяжёлые зависимости (Arrow) |
| `usearch` | 2.26.4 (2026-10-05), Apache-2.0 | HNSW, Rust, JS, WASM, квантование | Отдельный файл индекса, синхронизация с проекцией на нас |
| `hnsw_rs` | 0.3.5 (2026-10-09), MIT/Apache-2.0 | Чистый Rust HNSW | То же |
| `hnswlib-node` | 3.0.0 (2024-03-11), Apache-2.0 | — | Не развивается |

Расчёт объёма (💡): 10 000 нод при ~3 чанках на заметку — это ~30 000 векторов. При 1024 измерениях float32 занимает ≈ 123 МБ, int8 — ≈ 31 МБ, бинарный — ≈ 3,8 МБ (с пересчётом топа по float). Полный перебор по 30 000 int8-векторов в C укладывается в десятки миллисекунд. Это оценка, не замер.

#### 5.5. Гибридный поиск (💡)

```
запрос ─┬─ tantivy BM25 (русский стеммер, R4) ── top 50 ─┐
        └─ эмбеддинг запроса → sqlite-vec KNN ── top 50 ─┴─ RRF ─ (реранкер, опц.) ─ top k → чанки → ноды
```

- Чанк — фрагмент заметки (по заголовкам, ~300–500 токенов) с **префиксом-контекстом**: `путь › имя ноды › заголовок раздела`. Это дешёвый аналог контекстных эмбеддингов.
- Индексируются заметки, списки, текстовые виджеты досок, подписи и OCR картинок (позже), сводки нод.
- Индексация — фоновая очередь в ядре, по событию «сохранён документ содержимого». Ленивая загрузка (N1) не страдает: индексатор читает документы по одному в фоне.
- `search_content` в MCP работает с первого дня в режиме `keyword` (tantivy есть в R4). Режим `semantic` появляется, когда пользователь включит локальную модель или API.

#### 5.6. LLM по ключу пользователя: «Разобрать текст в ноды»

| Провайдер | Что использовать | Источник |
|---|---|---|
| Anthropic | `claude-sonnet-5-5` ($2 / $10 за 1 M), дешёвый — `claude-haiku-5-5` (от $0,10 / $0,50). Structured outputs GA (`output_config.format`, `strict: true` у инструментов). **Нет рекурсивных схем**, нет `minLength`/`maximum` | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) |
| OpenAI | Structured outputs, SDK `openai` 7.32.0 (Apache-2.0, npm) | npm |
| Ollama (локально) | `format` = JSON Schema в `/api/chat`; v0.40.3 (11 октября); MIT | [api.md](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md), [релизы](https://github.com/ollama/ollama/releases/latest), [LICENSE](https://raw.githubusercontent.com/ollama/ollama/main/LICENSE) |
| Rust-клиенты | `async-openai` 0.42.2 (MIT), `genai` 0.6.5 (MIT OR Apache-2.0, мультипровайдер), `rig-core` 0.44.0 (MIT), `ollama-rs` 0.3.6 (лицензия «non-standard» на crates.io — проверять) | crates.io |

**Формат плана** (💡) — плоский, чтобы подходил всем провайдерам:

```json
{
  "nodes": [
    {"tmp": "n1", "kind": "network", "name": "Сюжет", "parent": "@target"},
    {"tmp": "n2", "kind": "note", "name": "Пролог", "parent": "n1", "content_md": "…"},
    {"tmp": "n3", "kind": "checklist", "name": "Требования", "parent": "n1", "items": ["…"]}
  ],
  "edges": [{"from": "n2", "to": "n3"}],
  "reuse": [{"tmp": "r1", "existing": "/Справочник/Персонажи"}]
}
```

Поток в приложении: выделить заметку или вставить текст → «Разобрать в ноды» → LLM возвращает план → **ноды-призраки** на холсте (полупрозрачные баблы) → «Применить» одной операцией с откатом. Поле `reuse` связывает план с существующими нодами: перед вызовом LLM получает кандидатов из `search_nodes` и `search_content`. Так новый текст не плодит дубликаты, а прикрепляется к имеющимся нодам (✅ C3: одна нода в нескольких местах). Тот же `apply_graph_plan` вызывает внешний агент — там LLM сам агент.

Где хранить ключи: на десктопе — в системном хранилище ключей (keychain, Credential Manager, Secret Service), на сервере — в зашифрованных настройках пространства. Конкретный крейт выбирается в 15-architecture.

#### 5.7. Генерация изображений

| Провайдер | Модели (на 2026-10) | Особенности для Strata | Источник |
|---|---|---|---|
| **Anthropic** | **Нет генерации**: «Claude doesn't generate photos or illustrations the way image-generation tools do» (обновлено 2026-03-16) | Claude делает SVG, диаграммы, HTML | [support.claude.com](https://support.claude.com/en/articles/9002504-can-claude-produce-images) |
| OpenAI | `gpt-image-2` (снимок 2026-04-21), `gpt-image-2.5-sunburst` и `-flare` (2026-09-08), `gpt-image-1.5`, `gpt-image-1(-mini)`; `dall-e-2/3` выведены 2026-05-12 | **Прозрачный фон** (`background: "transparent"` + png/webp) — для иконок баблов; произвольные размеры до 3840×2160 у 2.5 | [openai-node images.ts](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/images.ts) |
| Google | `gemini-nano-banana-2.1` (stable, октябрь 2026; до 14 референсов, 1K/2K/4K); `gemini-3-pro-image`; Imagen снят с Gemini API | Редактирование по референсам — «перерисовать в стиле гравюры» | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1), [LiteLLM](https://docs.litellm.ai/blog/nano_banana_2_1), по данным поиска |
| Black Forest Labs | FLUX.2 [pro] по API; FLUX.2 [klein] 4B — **Apache-2.0**, ~13 ГБ VRAM; [klein] 9B и [dev] 32B — некоммерческая лицензия | Локальный вариант с открытой лицензией | [BFL docs](https://docs.bfl.ml/flux_2/flux2_overview), [flux2](https://github.com/black-forest-labs/flux2), по данным поиска |
| Replicate, fal | FLUX.2 [pro] ≈ $0,03–0,07 за картинку (разброс у агрегаторов) | Один ключ — много моделей | по данным поиска, не проверено |
| Recraft | V4.1 Vector и Pro Vector — **SVG** ≈ $0,08 и $0,30 | Векторные иконки, которые масштабируются в бабле | [OpenRouter](https://openrouter.ai/recraft/recraft-v4.1-vector-20260514), по данным поиска |
| Stability AI | Stable Image Ultra и Core, SD 3.5 по API ≈ $0,03–0,08 | Текущий статус API не проверен | по данным поиска |
| ComfyUI (локально) | Любые открытые модели; HTTP API: `POST /prompt` (workflow в API-формате) → `/ws` или `/history/{id}` → `/view`; порт 8188 | GPL-3.0 ([LICENSE](https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/LICENSE)). Strata общается по HTTP и не линкуется, поэтому лицензия не «заражает» | [runflow](https://www.runflow.io/blog/comfyui-api-developer-guide), по данным поиска |
| Ollama | Генерации картинок в API нет | — | [api.md](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md) |

Модели меняются быстро: за год сняты DALL·E и Imagen, `gpt-image-1` объявлен устаревшим. Поэтому в Strata нужен адаптер провайдеров с настройкой «модель по умолчанию», а не жёстко вшитые ID.

#### 5.8. Паттерн «агент генерирует — Strata принимает»

| Клиент | Как картинка попадает на доску |
|---|---|
| Codex CLI | Встроенный `image_gen` сохраняет файл. Дальше локально — `add_to_board(path)`, удалённо — `create_asset_upload` → `curl -T file <url>` → `add_to_board(asset_id)` |
| Claude Code | Картинку делает другой MCP-сервер или скрипт с ключом OpenAI/BFL, получается файл. Дальше как у Codex |
| Claude Desktop (без shell) | Байты картинки модель передать не может. Используем `generate_image` в Strata: генерирует сама Strata по ключу пространства и сразу кладёт на доску |
| Картинка по URL | `add_to_board(url)`: скачивает ядро или сервер (с лимитами размера и типов и защитой от SSRF) |

Пост-обработка (💡, 07-design-system): по флажку картинка для иконки переводится в монохромную «гравюру» дизерингом, как требует принцип «кастомизация в рамках грамматики» (03-vision).

## Сравнение вариантов

### Где живёт MCP-сервер

| Вариант | Покрытие клиентов | Сложность | Для Strata |
|---|---|---|---|
| A. Только stdio `strata mcp`, открывает пространство сам | Все | Низкая | Конфликт двух писателей с открытым приложением — нужен лок или IPC |
| **B. stdio-лаунчер → IPC к ядру (поднимает ядро без окна, если нужно)** | Все | Средняя | 💡 Основной путь: один писатель, правки агента сразу видны на холсте |
| C. HTTP внутри приложения на 127.0.0.1 | Claude Code, Codex, Cursor; Claude Desktop — только через мост | Средняя | 💡 Опция, выключена по умолчанию |
| **D. `/mcp` на self-hosted сервере** | Claude Code, Codex, Cursor напрямую; Claude Desktop — через B с `--remote` или custom connector при публичном HTTPS | Высокая (авторизация) | 💡 Этап 3, обязательно для команды |
| E. Отдельный Node-сервер на TS SDK | Все | Вторая реализация модели | Нет: противоречит одному ядру (R4) |

### SDK

| Критерий | `rmcp` 3.5.1 | TS SDK 2.3.1 |
|---|---|---|
| Ревизии | `2026-07-28` + `2025-11-25` и раньше | `2026-07-28` (v2) |
| Вписывается в стек R4 | Да: Rust-ядро, сервер, CLI | Только при варианте «Electron + Node-ядро» |
| Серверный OAuth | Нет, только клиентский | Есть auth-хелперы |
| Риск | Частые мажорные версии | v1 → v2 уже прошла |

### Эмбеддинги

| Критерий | multilingual-e5-small | bge-m3 | Qwen3-Embedding-0.6B | EmbeddingGemma 2 | API (Voyage 4 / OpenAI) |
|---|---|---|---|---|---|
| Лицензия для поставки в open source | MIT | MIT | Apache-2.0 | Apache-2.0 | — |
| Длинные заметки | 512 токенов | 8192 | 32K | 8192 | 32K / 8K |
| Готовность в Rust (fastembed) | ✓ ONNX | ✓ ONNX, dense + sparse | ✓ candle | ✗ пока | HTTP |
| Картинки | ✗ | ✗ | ✗ (есть Qwen3-VL-Embedding-2B) | ✓ текст + картинки + аудио | voyage-multimodal-3.5 |
| Ресурсы | Минимальные | Средние | Средние | Средние (только текстовая часть) | Нет |
| Приватность | Локально | Локально | Локально | Локально | Текст уходит провайдеру |
| Роль | Лёгкий пресет | **Кандидат по умолчанию** | **Кандидат по умолчанию** | Кандидат на этап 3 (поиск по картинкам) | Опция |

### Векторное хранилище

| Критерий | sqlite-vec | LanceDB | usearch |
|---|---|---|---|
| Новая СУБД в стеке | Нет | Да | Отдельный индекс-файл |
| ANN | Только alpha | Да | Да (HNSW) |
| До ~100 000 векторов | Достаточно перебора | Избыточно | Избыточно |
| Решение | 💡 Брать | Нет | Запасной путь за trait `VectorIndex` |

### Генерация картинок по умолчанию

| Задача | 💡 Выбор | Почему |
|---|---|---|
| Иконки баблов | OpenAI `gpt-image-2` / `2.5` с прозрачным фоном или Recraft Vector (SVG) | Прозрачность и чистый силуэт, затем дизеринг в «гравюру» |
| Референсы и мудборды | `gemini-nano-banana-2.1` или `gpt-image-2.5` | Редактирование по референсам, качество |
| Локально, без облака | ComfyUI + FLUX.2 [klein] 4B (Apache-2.0) | Открытая лицензия, работает на домашней GPU |

## Рекомендация для Strata

### 1. Архитектура MCP (💡)

```
Claude Code / Codex / Cursor / Claude Desktop
        │ stdio                                   │ Streamable HTTP (+ PAT/OAuth)
        ▼                                          ▼
  strata mcp  ── IPC (Unix socket / named pipe) ── strata-core (Rust)        strata-server = strata-core + auth + sync
  (тот же бинарник;                                  ├─ доменные операции ◄──── /mcp (rmcp, dual-era)
   --remote <url> = stdio↔HTTP мост)                 ├─ SQLite-проекция: индекс, FTS (tantivy), векторы (sqlite-vec)
                                                     ├─ журнал агентов (changesets, origin=mcp:*)
                                                     └─ AI-адаптеры: эмбеддинги (fastembed), LLM, картинки
```

- **Один бинарник `strata`**: `strata mcp` (stdio), `strata mcp --remote https://…/mcp` (мост к серверу), `strata serve` (сервер). Используется `rmcp` 3.x с поддержкой `2025-11-25` и `2026-07-28` и с версией, закреплённой точно.
- **Подключение в один клик.** Экран «Подключить AI» в настройках Strata:
  - Claude Desktop — кнопка «Установить расширение» (`.mcpb` с `server.type: "binary"` для `darwin`, `win32`, `linux`);
  - Claude Code — готовая команда `claude mcp add --scope user strata -- <путь>/strata mcp --workspace <путь>`;
  - Codex — готовый блок TOML с `default_tools_approval_mode = "writes"`;
  - Cursor — блок JSON.
  Strata конфиги клиентов сама не правит, только показывает и копирует. Так нет риска «Claude Desktop переписал конфиг».
- **Почему так, в привязке к требованиям.** «Доступ к графу для Claude и Codex» (✅ K1) закрывает stdio-лаунчер. «Обязательная совместная работа» и self-hosted требуют `/mcp` на сервере. «Веб и десктоп — приоритет» — веб-пользователь подключает агента к серверу. Одно ядро не дублирует модель данных (R4).

### 2. Инструменты (💡)

| Этап | Инструменты |
|---|---|
| **MVP** | `get_workspace`, `search_nodes`, `query_nodes`, `search_content` (режим keyword), `get_node`, `list_network`, `get_neighbors`, `get_paths`, `get_image`, `get_ui_context`, `create_node`, `update_node`, `edit_note`, `edit_checklist`, `place_node`, `move_node`, `connect`, `insert_into_edge`, `apply_graph_plan`, `add_to_board` (path и url), `import_markdown`, `get_job`, `disconnect`, `remove_placement`, `trash_node`, `revert_changeset`. Ресурсы `strata://node/{id}` и `strata://network/{id}`. Промпты `structure_text`, `weekly_review` |
| Этап 2 | `search_content` с семантикой, `create_asset_upload`, `generate_image`, промпты `find_related`, `moodboard` |
| Этап 3 | Удалённый `/mcp`, расширение tasks для долгих операций, MCP Apps (мини-холст в чате) |

Это 26 инструментов в MVP. В Claude Code tool search грузит их лениво. `_meta["anthropic/alwaysLoad"]` ставим только на `search_nodes` и `get_node`.

### 3. Авторизация и права (💡)

1. **Локально** доверяем пользователю ОС. Профиль подключения задаёт скоуп: по умолчанию `read+write`; `trash_node` и `revert_changeset` требуют явного `--allow-delete` (❓ Q-R6-1).
2. **Сервер, этап 3а** — персональные токены (PAT) со скоупами `strata:read`, `strata:write`, `strata:delete`, привязкой к пространству и необязательным поддеревом. Этого хватает Claude Code (`--header`), Codex (`bearer_token_env_var`), Cursor (`headers`) и мосту `strata mcp --remote`.
3. **Сервер, этап 3б** — OAuth 2.1 для custom connectors в Claude, Claude Desktop и мобильного Claude: PRM (RFC 9728), PKCE S256, CIMD, DCR только для совместимости, проверка аудитории. Своего AS в `rmcp` нет. Два варианта:
   - встроенный минимальный AS (authorization code + PKCE, логин — учётка Strata);
   - делегирование внешнему OIDC-провайдеру, который self-hosted-пользователи обычно уже держат.
   Выбор — в 11-server-selfhost.
4. **Журнал и откат** с первого дня: журнал — это отдельная фича, которую видно в UI, и он нужен для доверия к агентам.
5. **Массовые и опасные операции:** `dry_run` → `confirm_token` → применение. Где клиент умеет elicitation, дополнительно форма. В десктопе — тост подтверждения в окне Strata (❓ Q-R6-6).

### 4. Дорожная карта AI (💡, согласовать с 16-roadmap)

| Этап | Что | Зачем (требование) |
|---|---|---|
| **MVP** | Локальный MCP (п. 2), журнал и откат, `.mcpb` и экран «Подключить AI»; полнотекст tantivy в `search_content` | ✅ K1: Claude и Codex работают с графом, ищут по содержимому |
| **Этап 2** | Локальные эмбеддинги (по итогам спайка) + гибридный поиск; кнопка «Разобрать в ноды» с призраками; провайдеры LLM: Anthropic, OpenAI, Ollama; генерация картинок на досках и иконок с дизерингом; тикеты загрузки | ✅ K1: структуризация, генерация на холстах. ✅ N1: индексация в фоне |
| **Этап 3** (команда) | Удалённый `/mcp` (PAT → OAuth); лента действий агентов для команды; серверные эмбеддинги; AI-справка ноды для 3D-карточки (H4); подсказки связей — похожие ноды как приглушённые «предлагаемые нити»; поиск по картинкам досок (EmbeddingGemma 2 или voyage-multimodal); MCP Apps | Команда до 10 человек, 3D-справка, красота кодирует данные |

### 5. Спайки до ADR (💡, ~1 неделя)

1. **MCP-скелет на `rmcp` 3.5:** `search_nodes`, `get_node`, `create_node` с аннотациями. Проверить вживую:
   - Claude Code — v1 и v2 рантайм, `MCP_PROTOCOL_NEGOTIATION=legacy` и `auto`;
   - Claude Desktop — macOS или Windows и Linux-бета;
   - Codex — режимы `writes` и `prompt`;
   - Cursor.
   Замерить, какая ревизия реально договаривается.
2. **IPC-лаунчер:** два клиента одновременно плюс открытое окно Strata, правка агента появляется на холсте < 200 мс.
3. **Эмбеддинги на русском:** 50 запросов владельца к его vault (русский + английский). Сравнить bge-m3, Qwen3-Embedding-0.6B, multilingual-e5-small и (если будет ONNX) EmbeddingGemma 2 по recall@10, а также время индексации 10 000 нод на ноутбуке владельца и размер индекса. BM25-only — как базовая линия.
4. **`apply_graph_plan` с LLM:** 10 реальных текстов → план (Sonnet 5.5, Haiku 5.5, локальная модель через Ollama). Оценить долю планов, которые применяются без ручной правки, и качество `reuse`.
5. **Картинки:** тикет загрузки из Codex (`image_gen` → `curl -T` → доска) и `generate_image` из Claude Desktop.

### 6. Предлагаемые термины для глоссария (💡)

| Термин | В коде | Определение |
|---|---|---|
| Журнал агента | `AgentLog` | Список изменений, сделанных через MCP и AI-функции, с автором-клиентом и откатом |
| Пакет изменений | `Changeset` | Одна логическая правка агента или пользователя (несколько доменных операций), откатываемая целиком |
| План графа | `GraphPlan` | Плоское описание нод, размещений, нитей и содержимого с временными ID, которое применяется одной операцией |
| Нода-призрак | `ghost node` | Предпросмотр ноды из плана на холсте до применения |
| Тикет загрузки | `upload ticket` | Одноразовый URL для передачи файла в пространство мимо контекста модели |

## Риски

- **Переходный период MCP.** У клиентов разные ревизии (`2025-11-25` и `2026-07-28`), elicitation поддерживается неравномерно, у Codex своя трактовка аннотаций. Без «двухэпохального» сервера и спайка п. 1 часть клиентов отвалится.
- **Темп `rmcp`:** три мажорные версии за полгода, 12 релизов за 10 недель. Нужно точное закрепление версии и тонкий слой адаптера.
- **Claude Desktop:** `url` в конфиге не работает, custom connectors не видят LAN, на Linux только бета для Ubuntu и Debian. Пользователь на Arch, судя по референсу omarchy, может остаться только с Claude Code или Codex.
- **Prompt injection.** Импортированные веб-заметки и чужие ноды в команде — недоверенный контент. У агента с доступом к Strata и к вебу собирается «смертельная триада». Митигации: режим `read`, поддерево, отсутствие сетевых побочных эффектов у инструментов Strata, журнал и откат.
- **Массовая порча.** Агент «разложил» 300 нод не туда. Митигации: `dry_run`, лимиты на вызов и в минуту, changesets с откатом, мягкое удаление.
- **Объём ответов.** Выход за 25 000 токенов в Claude Code ухудшает работу агента — нужны дисциплина пагинации и тесты на большой базе.
- **Двоичные данные.** Base64 в аргументах портит файлы. Без тикетов загрузки «агент кладёт картинку» на удалённом сервере не работает.
- **Эмбеддинги.** Качество на русском не подтверждено. Модель занимает сотни мегабайт. Смена модели означает полную переиндексацию. `ort` ещё в RC. EmbeddingGemma 2 совсем новая. У Gemma 1 условия не open source.
- **Провайдеры картинок и LLM** быстро снимают модели (DALL·E, Imagen, `gpt-image-1`) и меняют цены. Ключи пользователя и расходы надо защищать: хранилище ключей, лимиты.
- **Свой OAuth AS** — значительная поверхность атаки. CIMD новый, DCR устарел.
- **`sqlite-vec` до v1:** формат может сломаться, ANN только в alpha. Нужен trait `VectorIndex`, чтобы перейти на usearch без переписывания.

## Открытые вопросы

- **Q-R6-1.** Что по умолчанию разрешено агенту: только чтение, чтение и запись без удаления или всё? Удаление — только с отдельным разрешением?
- **Q-R6-2.** Нужно ли подтверждать каждую правку агента в окне Strata или достаточно применять сразу с журналом и откатом, а подтверждать только массовые и удаляющие?
- **Q-R6-3.** Должны ли быть ноды или сети, скрытые от AI (флаг «не показывать агентам»)? Если да, это новое поле в модели данных и ADR.
- **Q-R6-4.** Какими AI-сервисами вы готовы пользоваться и платить по своему ключу (Anthropic, OpenAI, Google, OpenRouter)? Нужен ли режим «никаких облаков» только с локальными моделями (Ollama, ComfyUI)?
- **Q-R6-5.** На какой ОС и каком железе вы работаете (дистрибутив Linux, есть ли дискретная GPU)? От этого зависят Claude Desktop, локальная генерация картинок и выбор модели эмбеддингов.
- **Q-R6-6.** Командный сервер будет доступен из интернета (тогда работают custom connectors Claude и мобильный Claude) или только в локальной сети / VPN?
- **Q-R6-7.** Нужен ли поиск по смыслу в самом интерфейсе Strata (отдельная панель) или достаточно, что он доступен агентам через MCP?
- **Q-R6-8.** Сгенерированные картинки для иконок автоматически переводить в ч/б «гравюру» (дизеринг) или оставлять как есть с выбором?
- **Q-R6-9.** Можно ли при первом включении семантического поиска скачивать модель на 0,1–1 ГБ?
- **Q-R6-10.** Должно ли ядро Strata работать в фоне при закрытом окне, чтобы агенты имели доступ к пространству всегда (связано с Q-R4-9)?

## Источники

Спецификация и SDK MCP:
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-11-25/changelog.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/changelog.mdx
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/versioning.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/stdio.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/index.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/client-registration.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx
- https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/README.md
- https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/LICENSE
- https://raw.githubusercontent.com/modelcontextprotocol/rust-sdk/main/docs/OAUTH_SUPPORT.md
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md
- https://crates.io/crates/rmcp
- https://www.npmjs.com/package/@modelcontextprotocol/server
- https://www.npmjs.com/package/@modelcontextprotocol/sdk
- https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036

Клиенты:
- https://code.claude.com/docs/en/mcp
- https://claude.com/docs/connectors/building/mcpb
- https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/MANIFEST.md
- https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
- https://docs.timbr.ai/doc/docs/integration/mcp/claude
- https://startdebugging.net/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/
- https://github.com/anthropics/claude-code/issues/37286
- https://itbrief.co.uk/story/anthropic-launches-claude-desktop-beta-for-linux-users
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/config-reference
- https://www.tembo.io/blog/codex-cli-mcp
- https://unwait.ai/blog/codex-mcp
- https://codex.danielvaughan.com/2026/05/19/codex-cli-mcp-server-management-cli-commands-oauth-streamable-http-production-patterns/
- https://codex.danielvaughan.com/2026/07/20/writes-mode-permission-primitive-codex-cli-approval-least-privilege/
- https://codex.danielvaughan.com/2026/06/03/codex-cli-mcp-v0136-per-server-env-targeting-oauth-streamable-http-concurrent-tools/
- https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/
- https://github.com/openai/codex/issues/16501
- https://github.com/gwicho38/mitodo/issues/10
- https://www.truefoundry.com/blog/mcp-authentication-in-cursor-oauth-api-keys-and-secure-configuration
- https://docs.pipeshub.com/mcp/cursor
- https://www.npmjs.com/package/@openai/codex
- https://www.npmjs.com/package/@anthropic-ai/claude-code

Проектирование инструментов и безопасность:
- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://blog.jztan.com/mcp-file-upload-base64-corruption/
- https://sunpeak.ai/blogs/file-uploads-mcp-apps
- https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/

Эмбеддинги и векторный поиск:
- https://raw.githubusercontent.com/Anush008/fastembed-rs/main/README.md
- https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/research/BGE_M3/README.md
- https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE
- https://raw.githubusercontent.com/QwenLM/Qwen3-Embedding/main/README.md
- https://huggingface.co/google/embeddinggemma-300m
- https://ai.google.dev/gemma/terms
- https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX
- https://www.marktechpost.com/2026/10/06/google-deepmind-releases-embeddinggemma-2-a-740m-open-multimodal-embedding-model-built-on-gemma-4/
- https://x.com/Google/status/2107505117511528640
- https://www.promptlayer.com/models/multilingual-e5-small
- https://zilliz.com/ai-models/snowflake-arctic-embed-l-v2.0
- https://aclanthology.org/2025.naacl-long.12/
- https://platform.claude.com/docs/en/build-with-claude/embeddings
- https://raw.githubusercontent.com/openai/openai-node/master/src/resources/embeddings.ts
- https://aiapiprices.com/embeddings-api-pricing/
- https://tokencost.app/blog/gemini-embedding-2-pricing
- https://github.com/huggingface/transformers.js/releases
- https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md
- https://raw.githubusercontent.com/asg017/sqlite-vec/main/LICENSE-MIT
- https://github.com/asg017/sqlite-vec/releases
- https://sqlite.org/forum/forumpost/9fea7e0fbb6ddd2f
- https://raw.githubusercontent.com/lancedb/lancedb/main/README.md
- https://crates.io/crates/fastembed
- https://crates.io/crates/ort
- https://crates.io/crates/sqlite-vec
- https://crates.io/crates/lancedb
- https://crates.io/crates/usearch

LLM и генерация изображений:
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://support.claude.com/en/articles/9002504-can-claude-produce-images
- https://raw.githubusercontent.com/openai/openai-node/master/src/resources/images.ts
- https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1
- https://docs.litellm.ai/blog/nano_banana_2_1
- https://docs.bfl.ml/flux_2/flux2_overview
- https://github.com/black-forest-labs/flux2
- https://openrouter.ai/recraft/recraft-v4.1-vector-20260514
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/LICENSE
- https://www.runflow.io/blog/comfyui-api-developer-guide
- https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md
- https://raw.githubusercontent.com/ollama/ollama/main/LICENSE
- https://github.com/ollama/ollama/releases/latest
- https://developer.puter.com/tutorials/stability-ai-api-pricing/
