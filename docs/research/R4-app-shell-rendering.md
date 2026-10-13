# R4. Оболочка приложения, рендер 2D/3D и редактор текста

> Дата исследования: 2026-10-13. Версии пакетов сняты напрямую из npm registry и crates.io API в этот день. Исходные тексты документации Tauri, README и исходники библиотек читались из GitHub (raw). Сайты tauri.app, electronjs.org, pixijs.com, threejs.org, codemirror.net, sqlite.org и ряд других из среды исследования напрямую не открывались. Сведения с них взяты из выдачи поиска и помечены «по данным поиска». Всё, что проверить не удалось, помечено «не проверено».

## Кратко

- **Оболочка: Tauri 2 (2.12.3) — по умолчанию, но с обязательной проверкой Linux.** Tauri даёт крошечный бандл (минимальное приложение < 600 КБ против 117–151 МБ одного только рантайма Electron 44), Rust-ядро, общее с self-hosted сервером и MCP, подписанный автоапдейтер и sidecar. Слабое место — **WebKitGTK на Linux**: сама документация Tauri предупреждает, что WebGL там может «молча» уйти на медленный путь, а определить это изнутри нельзя. Референс omarchy.org (Arch + Hyprland) намекает, что основной пользователь может сидеть именно на Linux/Wayland.
- **Tauri 3 (alpha с 2026-09-12) вводит выбор рантайма: системный WebView (wry) или Chromium через CEF** (`tauri-runtime-cef` 3.0.0-alpha.5, CEF 152). Это закрывает Linux-риск без смены стека, но пока это alpha. Запасные пути: Electron 44 (Chromium 152) как оболочка для Linux либо временный режим `strata serve` + Chromium-окно.
- **2D-холст: PixiJS v8 (8.22.0), а не SVG/DOM и не three.js.** WebGL по умолчанию, WebGPU опционально, с 8.16 есть Canvas2D-фолбэк, что решает проблему «сломанного GPU» на Linux. Готовы BitmapText с MSDF, работа в Web Worker и culling. Нити Безье для тысяч анимированных связей рисуются своим инстансным мешем с вычислением кривой в вершинном шейдере. Хит-тест и «бросить ноду на нить» строятся на rbush.
- **3D: three.js r186 (0.186.1) на WebGLRenderer + InstancedMesh/Points.** Физика — d3-force-3d или ngraph (Barnes–Hut) в воркере, с LOD по скоплениям. WebGPURenderer с фолбэком на WebGL2 пока держим как следующий шаг: под него не работают troika-three-text и pmndrs postprocessing v6. **3d-force-graph** годится только для прототипа: по объекту на ноду, физика в главном потоке. **cosmos.gl** под MIT, но умеет только 2D. **Cosmograph** под CC-BY-NC-4.0 — брать нельзя.
- **Один движок на 2D и 3D не нужен.** Плавный переход делаем «камерой-мостом»: three.js отрисовывает текущую сеть в тех же экранных координатах, что и Pixi, подменяет кадр незаметно и затем анимирует камеру и позиции к звёздной карте. Pixi и three при этом могут делить один WebGL-контекст (официальный гайд PixiJS).
- **UI-фреймворк: React 19 (19.3.0) + React Compiler 1.0.** Решающий аргумент — Excalidraw (0.18.1) существует только как React-компонент (peer `react` 17–19). Горячий путь (холст, 3D) идёт мимо React. Svelte 5 легче, но потребовал бы React-остров. Solid 2.0 ещё RC.
- **Редактор: CodeMirror 6 (`@codemirror/view` 6.43.14).** Его же использует Obsidian (peer-зависимости `obsidian` API 1.14.4). Документ — это сам Markdown-текст, поэтому round-trip байт-в-байт гарантирован. Live preview строится на decorations. ProseMirror-семейство (TipTap 3.32, Milkdown 7.22, BlockNote 0.55) пересобирает Markdown из дерева и нормализует его. BlockNote прямо называет экспорт «Lossy».
- **Локальное ядро: Rust** — rusqlite 0.40 с встроенным SQLite, notify 8.2 / 9.0-rc, tantivy 0.26 со стеммером для русского, rmcp 3.5 (официальный Rust SDK MCP). Тот же крейт работает в self-hosted сервере и в `strata mcp`. UI остаётся чистым TypeScript-SPA за интерфейсом `Backend`, поэтому веб-сборка и десктоп используют один код. Если в команде нет Rust (B2 открыт), то целостная альтернатива — Electron + Node-ядро.

## Находки

### 1. Оболочка: Tauri 2 против Electron

#### 1.1. Версии и состояние на 2026-10-13

| Проект | Версия, дата | Лицензия | Что важно |
|---|---|---|---|
| Tauri | 2.12.3 (2026-10-10); стабильная 2.0.0 вышла 2024-10-02 | Apache-2.0 OR MIT | Системный WebView через [WRY](https://github.com/tauri-apps/wry) 0.57 и окна через TAO 0.37 ([README](https://github.com/tauri-apps/tauri/blob/dev/README.md)) |
| Tauri 3 | 3.0.0-alpha.0 (2026-09-12/13), CLI 3.0.0-alpha.4 | Apache-2.0 OR MIT | Рантайм выбирается при сборке: `tauri-runtime-wry` или `tauri-runtime-cef` ([release notes](https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0)) |
| `tauri-runtime-cef` | 3.0.0-alpha.5 (2026-10-01) | Apache-2.0 OR MIT | «Tauri runtime interface for Chromium Embedded Framework» ([crates.io](https://crates.io/crates/tauri-runtime-cef)). В alpha.1 обновлён CEF до 152.3.0+152.0.6 ([релизы](https://github.com/tauri-apps/tauri/releases?q=cef)) |
| Electron | 44.7.0 (2026-10-07); 44.0.0 — 2026-08-25; 45.0.0-beta.2 | MIT | Chromium 152.0.7977.54, V8 15.2, Node 24.18.1. Требует macOS 13+, 32-битные сборки убраны ([v44.0.0](https://github.com/electron/electron/releases/tag/v44.0.0)). Мажорные релизы выходят примерно раз в 8 недель (по датам npm: 39 — 2025-10-27, 40 — 2026-01-16, 41 — 03-11, 42 — 05-06, 43 — 06-30, 44 — 08-25) |

Tauri 3 alpha.0 также: Linux-привязки GTK стали opt-in (`gtk3`/`gtk4`), CEF-рантайм включает GTK 4, трей на Linux по умолчанию работает через ksni без libayatana-appindicator, MSRV — Rust 1.95 ([release notes](https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0)). Сроки стабилизации Tauri 3 не объявлены (не проверено).

#### 1.2. Размер и память

| Метрика | Tauri | Electron | Источник |
|---|---|---|---|
| Минимальное приложение | «less than 600KB» | — | [Tauri docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/start/index.mdx) |
| Только рантайм (zip) | — | linux-x64 117 МБ, darwin-arm64 124 МБ, win32-x64 151 МБ (v44.7.0) | [ассеты релиза](https://github.com/electron/electron/releases/tag/v44.7.0) |
| Реальное приложение (запись экрана, тест Better Stack, обновлён в 2026-07) | 57 МБ, ~109 МБ RAM после запуска, старт 311 мс | 323 МБ, ~128 МБ RAM, старт 273 мс | [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/), по данным поиска |

Выводы. По размеру Tauri выигрывает на порядок. По памяти разрыв скромнее, чем обещают блоги (~15% в единственном методичном тесте). На macOS системный WebView работает в отдельных процессах, поэтому Activity Monitor недосчитывает Tauri (по данным поиска, там же). По времени старта Electron в этом тесте даже быстрее: Tauri ждёт инициализации системного WebView. Для Strata память и старт не решают. Решает **предсказуемость GPU-рендера** (1.3).

#### 1.3. WebView по платформам и графика

| Платформа | Движок в Tauri 2 | WebGL2 | WebGPU | Риски |
|---|---|---|---|---|
| Windows | WebView2 (Chromium, «evergreen», обновляется сам, предустановлен в Win 11) ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/reference/webview-versions.md)) | Да | Да: Chromium на Windows с версии 113 ([gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), правка 2026-10-02) | Минимальные |
| macOS | WKWebView. Обновляется только с ОС: «unsupported macOS versions do not receive WebKit updates» ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/reference/webview-versions.md)) | Да | Только Safari/WebKit 26 (macOS Tahoe 26): «supported and enabled by default» ([gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). Включено ли в WKWebView у сторонних приложений, официально не подтверждено. Инженер Apple на форуме: в WKWebView заработает, когда фича «enabled by default» ([forum](https://developer.apple.com/forums/thread/770862)) | В WKWebView частота кадров может быть ограничена 60 Гц даже на ProMotion: открытый запрос [WebKit 294338](https://bugs.webkit.org/show_bug.cgi?id=294338) (2025), на macOS 26 жалобы на 60 fps. Не проверено для 2026 |
| Linux | WebKitGTK (`webkit2gtk-4.1`), версия зависит от дистрибутива | Формально да, фактически может уйти на медленный путь | Не подтверждено. WebKitGTK в таблице gpuweb не описан, в релизах 2.50–2.52 WebGPU не упоминается ([2.52.2](https://webkitgtk.org/2026/04/13/webkitgtk2.52.2-released.html), [2.51.1](https://webkitgtk.org/2025/10/24/webkitgtk2.51.1-released.html)). Есть коммит «enable WebGPU in open-source builds» ([bug 306223](https://bugs.webkit.org/show_bug.cgi?id=306223), 2026-01), но попадание в GTK-сборки не проверено | **Главный риск**, см. ниже |
| Linux (Electron или Tauri 3 + CEF) | Chromium 152 | Да | В Chrome на Linux WebGPU включён для Intel Gen12+ (с 144) и NVIDIA 535.183+ под Wayland (с 147), остальное за флагом ([gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). Что Electron наследует это поведение, вывод, не проверено | Стандартный Chromium-GPU-стек |

**Что пишет сама документация Tauri о Linux** ([Linux Graphics Issues](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/Debug/linux-graphics.md), опубликовано на v2.tauri.app/develop/debug/linux-graphics):
- На NVIDIA бывают пустое окно, мерцание, падение при ресайзе (`AcceleratedSurfaceDMABuf…`, `Error 71`). Обходы: `__NV_DISABLE_EXPLICIT_SYNC=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` (ценой быстрого пути), `WEBKIT_DISABLE_COMPOSITING_MODE=1` (крайняя мера).
- «WebGL2 context creation succeeds even when the result is backed by a software rasterizer or a slow presentation path. There is no error to catch.»
- «WebKitGTK masks the WebGL renderer string… `WEBGL_debug_renderer_info` reports `Apple GPU` on every Linux machine.»
- Рекомендация: «give it a non WebGL fallback on Linux and consider exposing a setting so users can switch».

Для продукта, у которого холст и 3D — основной интерфейс, это прямое предупреждение. Если окажется, что владелец работает на Omarchy (Arch + Hyprland, Wayland; [The New Stack](https://thenewstack.io/what-is-omarchy-linux-and-why-is-37signals-moving-to-it/)), Linux становится основной платформой, а не третьей.

**OffscreenCanvas.** В Safari 16.4 OffscreenCanvas умел только 2D-контекст, WebGL в воркере возвращал `null` ([WebKit 183720](https://bugs.webkit.org/show_bug.cgi?id=183720)). С Safari 17 «shipped with WebGL support with OffscreenCanvas» ([WebKit 263010](https://bugs.webkit.org/show_bug.cgi?id=263010)). Явного подтверждения для `webgl2` в воркере и для WebKitGTK нет (не проверено).

#### 1.4. Файлы, watcher, фоновые процессы, sidecar, MCP

| Задача | Tauri 2 | Electron 44 |
|---|---|---|
| Файловая система | Rust-ядро (std/tokio) без ограничений. Из JS — `@tauri-apps/plugin-fs` 2.7 со scope-ограничениями ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/file-system.mdx)) | Node `fs` в main/utility-процессе |
| Watcher | `notify` в Rust. В plugin-fs есть `watch` (debounced) и `watchImmediate` ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/file-system.mdx)) | `@parcel/watcher` 2.6.0 или `chokidar` 5.0.0 (npm) |
| Фоновая работа | Core-процесс — «the only component with full access to the operating system», в нём живут глобальное состояние и подключения к БД ([process model](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/concept/process-model.md)) | `utilityProcess.fork()` — аналог `child_process.fork` на Chromium Services API, с MessagePort к рендереру ([docs](https://electronjs.org/docs/latest/api/utility-process), по данным поиска). В 44.0 ускорен старт `utilityProcess.fork()` ([v44.0.0](https://github.com/electron/electron/releases/tag/v44.0.0)) |
| Внешние бинарники | `bundle.externalBin` с суффиксом `-$TARGET_TRIPLE` ([sidecar](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/sidecar.mdx)). Есть гайд по Node.js-sidecar, «applicable for desktop operating systems only» ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/learn/sidecar-nodejs.mdx)) | Любой бинарник через `child_process` |
| IPC с UI | Команды сериализуются в JSON. Для больших данных есть `tauri::ipc::Response` (ArrayBuffer). Event system «is not designed for low latency or high throughput», для потоков — channels ([calling-rust](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-rust.mdx), [calling-frontend](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-frontend.mdx)) | IPC, MessagePort |
| MCP-сервер | Rust SDK `rmcp` 3.5.1 (Apache-2.0, [modelcontextprotocol/rust-sdk](https://github.com/modelcontextprotocol/rust-sdk)) | TS SDK `@modelcontextprotocol/sdk` 1.32.1 (MIT, npm) |

Следствие для MCP. Claude Code, Claude Desktop и Codex запускают локальный MCP-сервер как отдельную команду (stdio). Поэтому в поставку нужен CLI-вход `strata mcp`: отдельный бинарник в бандле Tauri или подкоманда того же Rust-бинарника. Он подключается к запущенному ядру через локальный сокет либо открывает пространство сам. Детали — в R6.

#### 1.5. Автообновление

- **Tauri:** `tauri-plugin-updater` 2.13.3. Источник — сервер или статический JSON. Подпись обязательна: «This cannot be disabled». Потеря приватного ключа означает невозможность выпускать обновления. Поддерживаются AppImage на Linux, MSI/NSIS на Windows, `.app.tar.gz` на macOS ([docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/updater.mdx)).
- **Electron:** встроенный `autoUpdater` (Squirrel) работает только на macOS и Windows: «There is no built-in support for auto-updater on Linux» ([docs](https://electronjs.org/docs/latest/api/auto-updater), по данным поиска). На практике берут `electron-updater` из electron-builder.

#### 1.6. Мобильные

Tauri 2 официально собирает iOS и Android: WKWebView и Android System WebView, плагины на Swift и Kotlin ([README](https://github.com/tauri-apps/tauri/blob/dev/README.md), [блог 2.0](https://v2.tauri.app/blog/tauri-20/)). Sidecar и Node-sidecar описаны только для десктопа. Electron мобильных не умеет. Мобилка для Strata «на потом», поэтому это бонус Tauri, а не аргумент. Тот же TS-UI можно выпустить и как PWA.

#### 1.7. Один TypeScript UI для десктопа и веб-сборки

Tauri отдаёт фронтенд через собственный протокол без localhost-сервера ([README](https://github.com/tauri-apps/tauri/blob/dev/README.md)). Значит, артефакт Vite-сборки один, а разница сводится к реализации доступа к данным.

```ts
interface Backend {            // один контракт для всех сборок
  index(): Promise<WorkspaceIndex>;
  openDoc(id: DocId): DocHandle; // CRDT-документ сети или содержимого
  assets: AssetStore;
  search(q: string): Promise<Hit[]>;
}
// TauriBackend  — invoke + channels в Rust-ядро того же процесса
// RemoteBackend — HTTP + WebSocket к self-hosted серверу (тот же протокол, что у ядра)
```

Ограничения веба: нет прямого доступа к папке vault. `showDirectoryPicker` есть только в Chromium («Firefox: not supported. Safari: not supported»), запасной путь — `<input webkitdirectory>` ([web.dev](https://web.dev/articles/files/open-a-directory)). Офлайн-кэш в браузере — IndexedDB или OPFS (раздел 7).

#### 1.8. Кратко об альтернативах

- **Wails** (Go): v2 стабилен, v3 всё ещё beta (`@wailsio/runtime` 3.0.0-beta.29 от 2026-10-13, npm; [релизы](https://github.com/wailsapp/wails/releases)). Те же системные WebView, что у Tauri, значит, та же проблема Linux, плюс Go вместо Rust. Преимуществ для Strata нет.
- **Neutralinojs**: системный WebView (на Linux — webkit2gtk), WebSocket к нативному слою, расширения через IPC ([README](https://github.com/neutralinojs/neutralinojs)). Слишком тонкий для ядра с БД, индексом и MCP.
- **Deno Desktop** (Deno 2.9, 2026-06-25, experimental): бэкенды `webview` (системный) и `cef` (~40 МБ и ~150 МБ по докам Deno; по данным поиска, [i-programmer](https://www.i-programmer.info/news/167-javascript/18978-deno-29-adds-desktop-app-builder.html)). Интересно как TS-only вариант с выбором Chromium, но пока экспериментально.

### 2. 2D-рендер холста: тысячи анимированных нод и нитей Безье

#### 2.1. Почему не SVG/DOM

- Каждый бабл и каждая нить становятся DOM-узлами со стилями, layout и hit-тестом браузера. Мейнтейнер React Flow называл предел «~1000 nodes… depending on the complexity of the nodes» (2021, официальный гайд чисел не даёт; [performance guide](https://reactflow.dev/learn/advanced-use/performance), по данным поиска).
- tldraw тянет большие сцены на DOM только за счёт culling (`display: none` вне вьюпорта), LOD и R-tree. В 4.4 (2026-02) индикаторы фигур перенесены из SVG в canvas 2D, «до 25x быстрее» ([culling](https://tldraw.dev/sdk-features/culling), [4.4](https://tldraw.dev/blog/tldraw-sdk-4.4), по данным поиска). Даже DOM-ориентированные редакторы уходят в canvas там, где элементов много.
- Obsidian перевёл граф с D3/SVG на PixiJS (WebGL), потому что SVG не тянул тысячи заметок (форум Obsidian, по данным поиска: [833](https://forum.obsidian.md/t/what-is-the-tech-stack-currently/833), [41020](https://forum.obsidian.md/t/understanding-the-graph-view-core/41020)).

DOM оставляем для того, где он сильнее: окна и панели UI, редактор текста, доска Excalidraw, инфокарточки. Ввод текста, IME для кириллицы, выделение, доступность и пиксельные шрифты в CSS там работают «из коробки».

#### 2.2. Canvas2D

Без шейдеров и инстансинга. Тысячи Безье-кривых с анимацией упираются в CPU: каждая кривая каждый кадр заново растеризуется. Годится как **фолбэк** для машин со сломанным GPU (см. Linux), но не как основной путь при требовании «тысячи нод без лагов» и эффектах в духе «Мора».

#### 2.3. PixiJS v8

- Версия 8.22.0 (2026-10-01), MIT. Ветка v8 выпускает минорный релиз примерно раз в месяц (npm).
- **Порядок рендереров по умолчанию:** `renderPriority = ["webgl", "webgpu", "canvas"]`. WebGPU включается явно через `preference`. **CanvasRenderer появился в 8.16.0 (2026-02-03)**: проверено по содержимому npm-пакетов, в 8.15 его нет, в 8.16 есть ([autoDetectRenderer.ts](https://github.com/pixijs/pixijs/blob/main/src/rendering/renderers/autoDetectRenderer.ts)). Это ровно тот «non WebGL fallback», который Tauri советует для Linux.
- Производительность: при запуске v8 «100k moving sprites» занимали ~15 мс CPU на кадр против ~50 мс в v7 (по данным поиска, [pixi v8 launches](https://pixijs.com/blog/pixi-v8-launches)). В 8.20 добавлены render bundles, частичные обновления буферов и WGSL-фолбэк для Safari (по данным поиска, [gamedev.net](https://gamedev.net/news/pixijs-v8200-released-r5221/)).
- **Culling:** `CullerPlugin` выключен по умолчанию, регистрируется через extensions, отбрасывает контейнеры вне экрана ([guide](https://pixijs.com/8.x/guides/components/application/culler-plugin), по данным поиска). Для холста Strata лучше свой culling по spatial index (2.6): он дешевле, чем обход сцены.
- **Воркер:** `DOMAdapter.set(WebWorkerAdapter)` до `init`, затем `transferControlToOffscreen()`. В воркере недоступны DOMContainer, AccessibilitySystem и загрузка FontFace, поэтому там нужны bitmap-шрифты ([environments](https://pixijs.com/8.x/guides/concepts/environments), по данным поиска).
- **Совместная работа с three.js в одном WebGL-контексте:** официальный гайд, `resetState()` перед каждым `render()`. Поддержка общего контекста улучшена в 8.7 ([guide](https://pixijs.com/8.x/guides/third-party/mixing-three-and-pixi), [8.7.0](https://pixijs.com/blog/8.7.0), по данным поиска).
- Привязки к фреймворкам: `@pixi/react` 8.0.5 (React ≥ 19), `svelte-pixi` 8.0.1. Для холста Strata их использовать **не стоит**: сцена из тысяч объектов должна обновляться императивно, а не через реконсилер.

#### 2.4. three.js с ортографической камерой как 2D-движок

Возможен: InstancedMesh сводит тысячи баблов к одному draw call. Ориентир с форума — «<100 draw calls и <100 000 вершин» ([docs](https://threejs.org/docs/#api/en/objects/InstancedMesh), [forum](https://discourse.threejs.org/t/the-best-approach-to-take-rendering-a-lot-of-meshes-that-can-be-transformed/42134), по данным поиска). Но 2D-инструментов в three.js нет: ни Graphics для путей и рамок, ни 2D-текста уровня BitmapText, ни Canvas-фолбэка, ни пиксельной привязки. Всё это пришлось бы писать самим. Подробнее — раздел 4.

#### 2.5. regl, свой WebGL2, deck.gl, sigma

- **regl** 2.1.1 (2024-11, MIT): тонкая обёртка над WebGL1, развивается медленно. Свой WebGL2-рендер даёт максимум контроля, но означает месяцы работы над текстом, батчингом и фолбэками, которые Pixi уже решил.
- **deck.gl** 9.4.0 (2026-09-05, MIT): одна библиотека с `OrthographicView` (2D) и `OrbitView` (3D) и переходами `viewState`. TextLayer строит SDF-атлас на лету с `characterSet: 'auto'` ([text-layer](https://github.com/visgl/deck.gl/blob/master/docs/api-reference/layers/text-layer.md), [views](https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/views.md)). Модель «слоёв данных» рассчитана на визуализацию, а не на редактор с drag и провод-жестами. Пригодность для Houdini-UX не проверена.
- **sigma** 4.0.1 (2026-10-13, MIT): WebGL-рендер графов поверх graphology. Это просмотрщик графа, а не нодовый редактор.

#### 2.6. Нити Безье в масштабе (оценка)

Требования R1 — кинетика нитей, перетаскивание, вставка в цепочку, нож. Значит, нити постоянно меняют геометрию. Тесселяция `Graphics.bezierCurveTo` на CPU при каждом изменении для тысяч нитей — узкое место. Это инженерная оценка, бенчмарк не проводился.

💡 Схема:
1. Одна инстансная полоса (strip) на N сегментов. Атрибуты инстанса — P0..P3, толщина, цвет и фаза анимации.
2. Кривая (Безье или прямая) вычисляется в вершинном шейдере, сглаживание — по расстоянию в фрагментном.
3. Обновляется только буфер изменённых нитей.
4. Стиль «линейный/Безье» переключается униформой.
5. Пунктир, «течение» и подсветка выполняются в шейдере без пересборки геометрии.

В Pixi v8 это делается через `Mesh` со своим `Shader` (WebGL и WebGPU).

#### 2.7. Текст: MSDF/SDF, пиксельные шрифты, кириллица

- **MSDF/SDF.** BitmapText в Pixi v8 загружает AngelCode BMFont и MSDF-совместимые `.fnt`/`.xml`. Такие шрифты «remain sharp at any size and scale», генерировать их предлагается через AssetPack ([bitmap text](https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap), по данным поиска). Для атласа с кириллицей — `msdf-atlas-gen` (MIT): `-type msdf|mtsdf`, `-charset` с диапазонами вида `[0x400, 0x4FF]`. Без charset берётся только ASCII ([README](https://github.com/Chlumsky/msdf-atlas-gen)). Атлас «латиница + кириллица + цифры + пунктуация» нужно задавать явно.
- **Динамический BitmapFont** (растеризация системного шрифта в атлас) покрывает любые символы, но не масштабируется без мыла. Подходит для подписей фиксированного экранного размера.
- **Пиксельные шрифты.** С Pixi 8.10 у текста есть `textureStyle: { scaleMode: 'nearest' }` «useful when rendering pixel fonts» ([8.10.0](https://pixijs.com/blog/8.10.0), по данным поиска). Чёткость получается только при **целочисленном** соотношении «пиксель шрифта : физический пиксель». Холст же масштабируется плавно, и вдобавок бывает дробный DPR (125%, 150%).
  - 💡 Правило: пиксельный шрифт — только в экранном пространстве (HUD, хлебные крошки, бейджи), с привязкой к целым физическим пикселям.
  - В мировом пространстве (подписи баблов) — MSDF.
  - Альтернатива для «тотального пиксель-арта» — рендер всего кадра в низкое разрешение с nearest-апскейлом. Это конфликтует с детальными гравюрными иконками «Мора».
- Наличие кириллицы в конкретных пиксельных шрифтах — тема R7.

#### 2.8. Хит-тест и пространственный индекс

- **rbush** 4.0.1 (MIT): динамическое R-дерево для точек и прямоугольников с bulk-вставкой, «hundreds of times faster than looping over all items» ([README](https://github.com/mourner/rbush)). Подходит для живого холста: при перетаскивании ноду удаляют и вставляют заново.
- **flatbush** 4.6.2 (ISC, 2026-06): «Static: you can't add/remove items after initial indexing», быстрее и компактнее, индекс — один ArrayBuffer, который можно передать между потоками ([README](https://github.com/mourner/flatbush)). Подходит для статичных слоёв: звёздная карта, мини-карта, импорт.
- 💡 Холст Strata. Ноды и рамки — в rbush в мировых координатах. Нити — bbox сегментов в rbush, точная проверка — расстояние до кривой. «Бросить ноду на нить» = запрос rbush по bbox перетаскиваемой ноды → кандидаты-нити → точный тест. Нож (`Y`) = отрезок жеста → кандидаты → пересечение с кривой. Встроенный EventSystem Pixi для тысяч объектов отключается (`eventMode: 'none'`), события обрабатываются своим слоем ввода.

#### 2.9. Рендер в Web Worker / OffscreenCanvas

Плюс: рендер не страдает от джанка главного потока (React, редактор, парсинг). Минусы: ввод пересылается в воркер с задержкой на кадр, DOM-фичи недоступны, нужна проверка поддержки. В Safari WebGL в OffscreenCanvas есть с 17-й версии, в WebKitGTK — не проверено. 💡 В MVP в воркеры выносим **симуляцию, раскладку (L), поиск и индексацию**, а рендер оставляем в главном потоке за тонкой границей «сцена ← снапшот». Перенос рендера в воркер — оптимизация после замеров.

### 3. 3D: звёздная карта

#### 3.1. three.js r186 и WebGPURenderer

- `three` 0.186.1 (2026-09-24; 0.186.0 — 2026-09-08), MIT. Релизы выходят каждые 1–2 месяца, API меняется. Версию нужно пинить.
- r184–r186: TSL compile ускорен в 3 раза, `compileAsync()` неблокирующий, `compileComputeAsync()`, InstancedMesh с render bundles, WebXR на WebGPU, исправления BatchedMesh ([releases](https://github.com/mrdoob/three.js/releases)).
- **WebGPURenderer** использует WebGPU, если он есть, иначе WebGL 2. Принудительно: `forceWebGL: true` ([manual](https://threejs.org/manual/en/webgpurenderer), по данным поиска). WebGL-бэкенд WebGPURenderer — не тот же WebGLRenderer, результат может отличаться в блендинге и постобработке ([forum](https://discourse.threejs.org/t/webgpurenderer-forcewebgl-true-vs-webglrenderer/87805), по данным поиска). Официального статуса «production-ready» не нашёл (не проверено).
- Экосистема под WebGPURenderer отстаёт:
  - troika-three-text даёт «белый квадрат» под WebGPU ([forum](https://discourse.threejs.org/t/troika-three-text-and-webgpu/55737), по данным поиска);
  - pmndrs postprocessing 6.39.5 работает с WebGLRenderer, v7 в beta;
  - замены для текста на WebGPU — `three-msdf-text-utils` (ISC, `MSDFTextNodeMaterial`) и `pmndrs/text` («still in development») (по данным поиска).
- 💡 Вывод: стартовать на **WebGLRenderer** — проверенный путь и вся экосистема. Сцену строить на примитивах, которые есть в обоих рендерерах (InstancedMesh, Points, LineSegments, свои шейдеры минимальны). Переход на WebGPURenderer планировать, когда понадобятся compute-шейдеры для физики больших графов.

#### 3.2. Babylon.js

`@babylonjs/core` 9.30.0 (2026-10-08), Apache-2.0. Версия 9.0 вышла 2026-03-26: clustered lighting на WebGPU и WebGL2, Frame Graph, volumetric lighting, Node Particle Editor (по данным поиска: [cinevva](https://app.cinevva.com/signals/2026-03-27-browser-rendering-best-month), [windowsmode](https://www.windowsmode.com/babylon-js-9-0-released-build-immersive-3d-web-apps/)). Это полноценный игровой движок с инспектором, сильный в WebGPU. Для Strata он избыточен: нужны точки, линии, туман и bloom, а не PBR и физика тел. Экосистема графовой визуализации (3d-force-graph, troika, примеры) живёт вокруг three.js. Babylon оправдан, только если команда уже его знает.

#### 3.3. Как рисовать «скопления звёзд» (💡)

- Звёзды — `THREE.Points` или InstancedMesh из billboard-квадов со своим шейдером: круг с мягким гало, размер = важность, яркость и альфа = вторичность, жёлтый оттенок = подсветка. Тысячи–десятки тысяч точек — один draw call.
- Связи — один `LineSegments`/BufferGeometry с аддитивным блендингом. Тонкие линии толщиной больше 1px — инстансные квады.
- **Текст и инфокарточка — DOM-оверлей** над проекцией ближайших N нод. Он чёткий, с кириллицей и пиксельным шрифтом в CSS, в стиле ретро-окон, и не зависит от состояния 3D-текста под WebGPU. troika (SDF, генерация атласа на лету в воркере, .ttf/.otf/.woff без woff2; [README](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)) — для подписей «в мире» на WebGLRenderer.
- Пикинг — по rbush/flatbush в экранной проекции или GPU-пикинг по ID-буферу. Для мешей есть `three-mesh-bvh` 0.9.16.
- Данные — только индекс пространства и превью (глоссарий). Содержимое нод в 3D не грузится.

#### 3.4. 3d-force-graph (vasturiano)

- 1.80.1 (2026-09-29), MIT, зависит от `three >=0.179 <1`. Рендер — three.js/WebGL, физика — d3-force-3d (по умолчанию) или ngraph. `numDimensions` 1–3, `controlType`: `trackball | orbit | fly`, `cooldownTicks`/`cooldownTime`, `pauseAnimation()` ([README](https://github.com/vasturiano/3d-force-graph)).
- В README: `enablePointerInteraction` «at the cost of performance», рекомендуется выключать для максимальной скорости. Официальный пример «Larger graph» — около 4k элементов. Других цифр масштабирования в документации нет.
- Ноды задаются как `nodeThreeObject` → `Object3D` на каждую ноду, то есть по умолчанию без инстансинга. Физика считается в главном потоке. Вывод (не бенчмарк): для «без ограничения числа нод» это потолок, библиотека годится для **спайка за день**, но не как основа.

#### 3.5. Физика: Barnes–Hut, воркеры, GPU

| Вариант | Версия, лицензия | Свойства |
|---|---|---|
| d3-force-3d | 3.0.6 (2025-04-09), MIT | Drop-in замена d3-force, 1–3 измерения, octree для many-body ([README](https://github.com/vasturiano/d3-force-3d)). Обновляется редко |
| ngraph.forcelayout | 3.3.1 (2022-10-04), BSD-3-Clause | Любая размерность (`dimensions: 3`). «Body forces are calculated in `n*lg(n)` time with help of Barnes-Hut» ([README](https://github.com/anvaka/ngraph.forcelayout)). Стабилен, не развивается |
| cosmos.gl (`@cosmos.gl/graph`) | 3.5.1 (2026-10-08), **MIT** ([LICENCE в пакете](https://github.com/cosmosgl/graph)) | Симуляция и рендер целиком на GPU (WebGL через luma.gl ~9.3), «hundreds of thousands of points and links». **Только 2D**: позиции `[x1, y1, …]`. Инкубационный проект OpenJS Foundation, v3 переехал на luma.gl ([OpenJS](https://openjsf.org/blog/introducing-cosmos-gl), [v3](https://openjsf.org/blog/cosmos-gl-v3)). Не работает на Android без `OES_texture_float` |
| **Cosmograph** (`@cosmograph/cosmograph` 2.5.1, `@cosmograph/cosmos` 3.4.x) | **CC-BY-NC-4.0** (npm) | Некоммерческая лицензия, не OSI. **Нельзя** использовать в open source проекте, допускающем коммерческое использование. Старый пакет `@cosmograph/cosmos` < 2 тоже был CC-BY-NC-4.0 и помечен «moved to @cosmos.gl/graph» |
| GraphWaGu (исследование, 2022) | — | Fruchterman–Reingold и Barnes–Hut на WebGPU compute ([статья](https://unpaywall.org/10.2312%2FPGV.20221067)). Готовой 3D-WebGPU-библиотеки force layout в 2025–2026 не нашёл |

💡 Стратегия:
1. Начальная 3D-раскладка всего пространства считается в воркере (ngraph или d3-force-3d) либо в Rust-ядре. Результат кэшируется в индексе.
2. «Примитивная физика» в реальном времени — только для скоплений рядом с камерой. Дальние скопления — агрегированные импостеры (одна «туманность» на скопление).
3. Позиции передаются из воркера как transferable `Float32Array`. Для `SharedArrayBuffer` нужна cross-origin isolation (COOP/COEP); как это работает в собственном протоколе Tauri, не проверено.
4. При росте до десятков тысяч активных тел — Barnes–Hut в Rust→WASM или compute-шейдер (WebGPURenderer, `compileComputeAsync`).

#### 3.6. Полёт: WASD + мышь

- В three.js есть `FlyControls` и `PointerLockControls` (addons); 3d-force-graph даёт `controlType: 'fly'`.
- Pointer Lock API в WKWebView и WebKitGTK — не проверено.
- 💡 Управление в стиле Unreal: **зажатая ПКМ + WASD/QE + мышь для взгляда**, колесо — скорость. Pointer lock не нужен, жест знаком аудитории Houdini и Unreal. Pointer lock — опция там, где доступен.
- «Нырок» из 3D: `Enter` на ноде под прицелом → анимация к ней → переход в 2D-сеть (раздел 4).

#### 3.7. Постэффекты и их цена

| Эффект | Цена | Как делать дёшево |
|---|---|---|
| Туман (`Fog`/`FogExp2`) | Почти бесплатно: считается во фрагментном шейдере материала | Встроенный `scene.fog` |
| Размытый фон-фото («Мор») | Дорого, если блюрить каждый кадр | **Блюрить один раз** при загрузке или смене фона и хранить как текстуру. В 2D — так же, без `BlurFilter` на каждый кадр |
| Bloom | Самый дорогой: несколько полноэкранных проходов по мип-цепочке | Половинное разрешение, селективный bloom только для «ключевых» звёзд. В pmndrs postprocessing `EffectPass` «automatically organizes and merges any given combination of effects» ([README](https://github.com/pmndrs/postprocessing)) |
| Pixelation | Скорее снижает нагрузку: рендер в низкое разрешение и nearest-апскейл | Render target ¼–⅛ и апскейл |
| Dither (Bayer) | Один дешёвый проход или прямо в шейдере материала | Совместить с финальным проходом |

На встроенной графике ориентир — не больше одного-двух полноэкранных проходов в полном разрешении. Bloom по умолчанию включать с переключателем качества. Это оценка, замер — в спайке.

### 4. Один движок для 2D и 3D?

**Вариант A. Всё на three.js** (ортографическая или «почти ортографическая» камера для холста).
- ➕ Одна сцена, одни буферы позиций, один текст. Переход 2D↔3D — интерполяция камеры и позиций без подмены кадра. Один WebGL- или WebGPU-контекст.
- ➖ Нет 2D-инструментария:
  - путей (рамки, стикеры, пунктир, скругления);
  - готового BitmapText/MSDF уровня Pixi (troika только под WebGL);
  - Canvas-фолбэка — критично для Linux;
  - пиксельной привязки.
- ➖ Холст — 80% времени пользователя. Он получит инструментарий 3D-движка, а не 2D-фреймворка.

**Вариант B. PixiJS для 2D + three.js для 3D.**
- ➕ Каждый движок в своей нише. Холст с Canvas-фолбэком живёт даже там, где WebGL «медленный», а 3D можно честно отключить на слабой машине.
- ➖ Два ассет-пайплайна для иконок и текста. Переход нужно «режиссировать».
- ➖ Pixi и three могут делить один WebGL-контекст ([guide](https://pixijs.com/8.x/guides/third-party/mixing-three-and-pixi)), но только если оба на WebGL. Pixi на WebGPU и three на WebGL в одном контексте несовместимы.

💡 **«Камера-мост» для варианта B:**
1. По команде «в 3D» three.js строит текущую сеть в плоскости `z = 0` с теми же координатами. Перспективная камера с узким FOV ставится на расстояние, при котором экранный масштаб совпадает с зумом Pixi.
2. Иконки баблов — те же текстуры. В первом кадре изображения совпадают, Pixi-слой гаснет незаметно.
3. За 400–800 мс камера отъезжает и наклоняется, ноды текущей сети интерполируются к своим 3D-позициям в скоплении, проявляются остальные скопления.
4. Обратный «нырок» — в обратном порядке.

Полной непрерывности это не мешает. Полный морф всего пространства и не нужен: 2D-холст показывает **одну сеть**, а звёздная карта — **всё пространство**.

### 5. UI-фреймворк для окон и панелей

| Критерий | React 19 | Svelte 5 | SolidJS |
|---|---|---|---|
| Версия | 19.3.0 (2026-09-09); React Compiler 1.0 — 2025-10-07 | 5.57.2; руны с 5.0 (2024-10-19) | 1.9.17 стабильный; **2.0.0-rc.14** (2026-10-08), beta с 2026-03 |
| Excalidraw (доски, MVP) | Нативно: peer `react ^17 \|\| ^18 \|\| ^19` (0.18.1, 2026-04-20) | Через React-остров (`createRoot` в элементе): два фреймворка в бандле | То же, что Svelte |
| CodeMirror 6 | Фреймворк-агностичен, своя обёртка на 30 строк | То же | То же |
| Привязки 2D/3D | `@pixi/react` 8.0.5, `@react-three/fiber` 9.8.1 (React 19, <19.4) | `svelte-pixi` 8.0.1, `@threlte/core` 8.6.1 | `solid-three` 0.2.0 |
| Нодовые редакторы | `@xyflow/react` 12.12 | `@xyflow/svelte` 1.7 | — |
| Производительность | Достаточна для панелей; на горячем пути React нельзя | Меньше рантайм, точечные обновления | Наилучшая гранулярность |

Решающее: горячий путь (холст, 3D, физика) в любом случае императивный и живёт вне фреймворка. Фреймворк рисует только окна-диалоги, панели, Tab-меню, инспектор и хлебные крошки. Значит, «скорость фреймворка» не решает, а интеграция с Excalidraw решает. Привязки `@pixi/react` и R3F для холста Strata не нужны (см. 2.3).

### 6. Редактор Markdown с live preview и точным round-trip

| Редактор | Версия, лицензия | Модель документа | Сохранение исходного Markdown |
|---|---|---|---|
| **CodeMirror 6** | `@codemirror/view` 6.43.14 (2026-10-07), `state` 6.7.6, `lang-markdown` 6.5.2; MIT. Репозитории переехали с GitHub на `code.haverbeke.berlin` ([README](https://github.com/codemirror/view)) | Документ = текст. Lezer строит дерево разбора, вид — decorations поверх текста | **Байт-в-байт**: сериализации нет |
| ProseMirror / TipTap | TipTap 3.32.0 (2026-10-13), MIT; `@tiptap/markdown` с 3.7.0 (2025-10-14), парсер `marked` ^17 | Дерево узлов, Markdown — импорт и экспорт | Нормализуется. Вывод «CommonMark by default» плюс `++u++` и `==hl==`. Re-import даёт «simplified document», кастомные узлы требуют своих правил ([docs](https://tiptap.dev/docs/conversion/export/markdown/editor-extension), по данным поиска). В 3.17.1 и 3.20.2 чинили пустые строки и абзацы |
| Milkdown | 7.22.3 (2026-10-10), MIT | ProseMirror + remark (`remark-parse`/`remark-stringify`) | Нормализуется. У `remark-stringify` маркер списка по умолчанию `*`, есть правила `bulletOther` и т. п. ([README](https://github.com/remarkjs/remark/tree/main/packages/remark-stringify)). `-` → `*` и подобные правки неизбежны без тонкой настройки |
| BlockNote | 0.55.0; ядро MPL-2.0, пакеты `@blocknote/xl-*` — **GPL-3.0 OR PROPRIETARY** (npm) | Блоки (JSON) | Явно с потерями: API `blocksToMarkdownLossy`, вложенность у не-списков «un-nested», часть стилей удаляется ([docs](https://www.blocknotejs.org/docs/features/export/markdown), по данным поиска) |

- **Obsidian использует CodeMirror 6:** пакет `obsidian` 1.14.4 объявляет peer-зависимости `@codemirror/view` 6.43.13 и `@codemirror/state` 6.7.6 (npm). Live Preview устроен на replace-decorations, которые скрывают синтаксис вне курсора ([decorations](https://docs.obsidian.md/Plugins/Editor/Decorations), по данным поиска). Открытый эталон — [codemirror-rich-markdoc](https://github.com/segphault/codemirror-rich-markdoc).
- **Масштаб:** CM6 рендерит только вьюпорт с запасом. Официальный пример — документ на миллион строк ([Obsidian viewport](https://docs.obsidian.md/Plugins/Editor/Viewport), [пример](https://codemirror.net/examples/million), по данным поиска).
- **Совместная правка:** `y-codemirror.next` 0.3.6 (MIT) для Yjs. Для Loro — свой биндинг, выбор CRDT в R3. Совместный текст в CM6 — это CRDT над строкой, то есть над тем же Markdown. Модель хранения при этом не раздваивается.
- **Wikilinks → нити:** расширение Lezer-грамматики `[[…]]`, `![[…]]`, `==…==`, `%%…%%`, callouts. Синтаксис ссылок разобран в R2. Из дерева разбора извлекаются ссылки и превращаются в нити при сохранении документа содержимого.

### 7. Локальное ядро: Rust или TypeScript

| Задача | Rust | TypeScript (Node / браузер) |
|---|---|---|
| SQLite | `rusqlite` 0.40.2 (MIT). Требует SQLite ≥ 3.45.3, `bundled` компилирует свой (в master — 3.54.0). На `wasm32-unknown-unknown` работает через `sqlite-wasm-rs` (фича `ffi-sqlite-wasm-rs`; [README](https://github.com/rusqlite/rusqlite)) | Node: `better-sqlite3` 13.0.3 (MIT). Браузер: `@sqlite.org/sqlite-wasm` 3.53.4 (Apache-2.0), `wa-sqlite` (MIT с 2023-02-10; VFS: IDBBatchAtomicVFS, IDBMirrorVFS, AccessHandlePoolVFS, OPFSCoopSyncVFS и др.; [README](https://github.com/rhashimoto/wa-sqlite)) |
| Watcher | `notify` 8.2.0 (CC0-1.0; 9.0.0-rc.5): inotify / FSEvents / ReadDirectoryChangesW / kqueue / polling. `notify-debouncer-full` 0.7.0 ([README](https://github.com/notify-rs/notify)) | `@parcel/watcher` 2.6.0, `chokidar` 5.0.0 |
| Полнотекст | `tantivy` 0.26.2 (MIT): BM25, инкрементальная индексация, mmap. Стеммер включает **Russian** ([stemmer.rs](https://github.com/quickwit-oss/tantivy/blob/main/src/tokenizer/stemmer.rs)) | MiniSearch, FlexSearch и др. (не исследовалось подробно); в SQLite — FTS5 |
| CRDT | `loro` 1.16.2, `yrs` 0.28.0, `automerge` 0.12.0 (crates.io; выбор — R3) | `yjs` 13.6.33, Loro (WASM-сборка того же Rust) |
| MCP | `rmcp` 3.5.1 | `@modelcontextprotocol/sdk` 1.32.1 |
| Сервер | Тот же крейт в self-hosted сервере (axum/tokio) | Тот же код в Node-сервере |

OPFS в браузере: VFS `opfs` из официального SQLite WASM требует `SharedArrayBuffer` (COOP/COEP) и не работает в Safari до 17. `opfs-sahpool` работает с Safari 16.4 ([persistence](https://sqlite.org/wasm/doc/trunk/persistence.md), по данным поиска).

Следствие. «Индекс без ограничения числа нод», полнотекст на русском, watcher и MCP — серверные задачи, а не задачи UI. Им лучше жить в одном нативном ядре, которое одинаково работает на десктопе и на сервере. Веб-клиенту локальное ядро не нужно: его «ядро» — сервер, а офлайн-кэш при необходимости — wa-sqlite/OPFS или IndexedDB.

## Сравнение вариантов

### Оболочка

| | Tauri 2 (wry) | Tauri 3 + CEF | Electron 44 |
|---|---|---|---|
| Статус | Стабильно, 2.12.3 | Alpha (3.0.0-alpha.x) | Стабильно, 44.7.0 |
| Движок | WebView2 / WKWebView / WebKitGTK | Chromium (CEF 152) | Chromium 152 |
| Предсказуемость GPU | Windows отлично, macOS хорошо (WebGPU с macOS 26), **Linux рискованно** | Как Chrome | Как Chrome |
| Размер | От < 1 МБ (минимальное) до десятков МБ с ассетами (57 МБ в тесте Better Stack) | Порядка размера Chromium (не проверено; у Deno-CEF ~150 МБ) | 117–151 МБ рантайм |
| Ядро | Rust в процессе | Rust в процессе | Node в main/utility, Rust — как sidecar или napi |
| Автообновление | Встроено, подписи обязательны | То же | macOS/Windows встроено, Linux — electron-updater |
| Мобильные | iOS/Android | Android-биндинги остаются в wry | Нет |
| Кто так делает | — | — | Obsidian (Electron) |

### 2D-рендер

| | PixiJS 8 | three.js ortho | Свой WebGL2 / regl | Canvas2D | SVG/DOM |
|---|---|---|---|---|---|
| Тысячи анимированных нод и нитей | Да (батчинг, свои меши) | Да (инстансинг) | Да | Нет | Нет |
| Текст MSDF/пиксельный | BitmapText, nearest | troika (WebGL) | Писать самим | Нативно, медленно | Нативно |
| Фолбэк без WebGL | **Canvas-рендерер (8.16+)** | Нет | Нет | — | — |
| Воркер | WebWorkerAdapter | OffscreenCanvas | Да | Да | Нет |
| Объём своего кода | Средний | Высокий | Очень высокий | Средний | Низкий |

### 3D и физика

| | Рекомендация | Почему |
|---|---|---|
| Рендер | three.js r186, WebGLRenderer → позже WebGPURenderer | Экосистема, текст, постэффекты |
| Ноды и связи | Points/InstancedMesh + LineSegments | Один draw call на слой |
| Подписи и инфокарточка | DOM-оверлей (ближние N) + troika | Чёткость, кириллица, ретро-стиль |
| Физика | ngraph или d3-force-3d в воркере, LOD по скоплениям; позже Rust/WASM или GPU compute | n·log n, не блокирует UI |
| Не брать | Cosmograph (CC-BY-NC); 3d-force-graph как основу | Лицензия; масштаб |

### Редактор

| | CodeMirror 6 | TipTap / Milkdown | BlockNote |
|---|---|---|---|
| Round-trip Markdown | Точный | Нормализует | С потерями |
| Live preview как в Obsidian | Decorations (так делает Obsidian) | WYSIWYG «из коробки» | Блочный WYSIWYG |
| Лицензия | MIT | MIT | MPL-2.0 + GPL/проприетарные XL |

## Рекомендация для Strata

### Стек

| Слой | Выбор | Главная причина |
|---|---|---|
| Оболочка | **Tauri 2.x** (wry). На Linux — гейт качества; путь отступления — Tauri 3 + CEF, когда выйдет из alpha, или Electron-сборка | Rust-ядро общее с сервером и MCP, малый размер, апдейтер. Linux-риск закрывается сменой рантайма без переписывания UI |
| UI-фреймворк | **React 19 + React Compiler**, состояние графа вне React (свой стор или подписка на CRDT) | Excalidraw без «острова», экосистема. Горячий путь всё равно императивный |
| 2D-холст | **PixiJS 8** (WebGL по умолчанию, Canvas-фолбэк, WebGPU позже) + свои инстансные нити + rbush | Тысячи нод при 60 fps, MSDF-текст, фолбэк для Linux |
| 3D | **three.js** (WebGLRenderer), Points/InstancedMesh, DOM-инфокарточки, физика в воркере | Экосистема, простота, путь к WebGPU |
| Переход 2D↔3D | «Камера-мост» (раздел 4) | Плавность без одного движка на всё |
| Редактор | **CodeMirror 6** + Lezer-расширения OFM + decorations + CRDT-биндинг | Точный Markdown, совместимость с Obsidian, как в самом Obsidian |
| Ядро | **Rust**: rusqlite, notify, tantivy, CRDT-крейт из R3, rmcp | Одно ядро на десктоп, сервер и `strata mcp` |
| Окна UI | DOM + CSS (ретро-окна), пиксельные шрифты целыми размерами | Ввод, IME, доступность, чёткость |

### Архитектура в одну схему (💡)

```
┌──────────── TypeScript SPA (одна сборка) ─────────────┐
│ React: окна, панели, Tab-меню │ CM6 │ Excalidraw       │
│ Холст: PixiJS ←─ снапшот сцены ─┐                      │
│ 3D: three.js ←──────────────────┤  Workers: раскладка, │
│                                 │  физика, fuzzy-поиск │
│            Backend (интерфейс) ─┘                      │
└───────┬─────────────────────────────────┬─────────────┘
  TauriBackend (invoke/channels)    RemoteBackend (HTTP/WS)
        │                                 │
  strata-core (Rust) в процессе      strata-server (Rust) = strata-core + auth + sync
        │
  strata mcp (тот же крейт, stdio) ← Claude Code / Claude Desktop / Codex
```

### Почему так, в привязке к требованиям

- **Веб и десктоп — приоритет.** Одна TS-сборка, разница только в `Backend`. Сервер и десктоп разделяют Rust-ядро.
- **Совместная работа обязательна.** Сервер на том же ядре, CRDT-документы одинаковы локально и на сервере (R3).
- **MCP для Claude и Codex.** `strata mcp` из того же ядра, без второй реализации модели данных.
- **«Тысячи нод без лагов», ленивая загрузка.** Холст рисует только текущую сеть из документа сети. 3D использует индекс и превью. Содержимое грузится при открытии. Рендер на GPU с батчингом, индексы — в воркерах и в Rust.
- **Houdini-механики.** Вставка на нить, нож, шейк и выделение upstream требуют быстрого хит-теста по геометрии нитей. Это rbush плюс точная проверка, а не DOM-события.
- **Дизайн «Мора» + ретро-окна.** Холст на GPU: фон предблюрен, баблы-спрайты с гравюрными иконками, тонкие нити. Окна — DOM с пиксельными шрифтами и целочисленным масштабом.
- **3D с полётом, поиском, созданием и нырком.** three.js, управление ПКМ+WASD, DOM-карточки, «камера-мост» обратно в 2D.

### Спайки до фиксации ADR (💡, 1–2 недели)

1. **Холст:** Pixi 8, 5k и 10k баблов с иконками, 15k анимированных нитей (инстансный шейдер), MSDF-подписи кириллицей. Замер p95 времени кадра в Chrome, Safari, Firefox и в Tauri на WebView2, WKWebView, WebKitGTK на **реальной машине владельца**. Порог: p95 ≤ 16,7 мс при 5k нод на встроенной графике.
2. **Звёздная карта:** three.js, 20k точек, 30k связей, туман и bloom в половинном разрешении, ngraph в воркере.
3. **Переход** «камера-мост» туда и обратно.
4. **Редактор:** CM6 live preview + wikilinks. Round-trip реального vault через открыть → сохранить без правок → `diff` = пусто.
5. **Гейт Linux.** Если WebKitGTK не проходит п. 1–2:
   - Linux-сборка на Tauri 3 + CEF (если к тому моменту beta);
   - иначе Electron-оболочка только для Linux (UI и ядро не меняются; ядро — sidecar);
   - временно — `strata serve` + Chromium в режиме `--app`.

### Если в команде нет Rust (ответ на B2)

Целостная альтернатива: **Electron 44 + Node-ядро** (`better-sqlite3`, `@parcel/watcher`, MCP TS SDK) и **Node-сервер** на том же коде. Остальное без изменений: React, Pixi, three, CM6. Цена — 120–150 МБ рантайма, больше RAM и медленнее полнотекст и индексация. Взамен один язык и Chromium на всех ОС, то есть нет Linux-риска.

## Риски

1. **WebKitGTK (Linux):** WebGL может молча работать медленно, renderer-строка замаскирована, WebGPU не подтверждён. Если основной пользователь на Linux/Wayland, это риск №1. Смягчение: гейт-спайк, Canvas-фолбэк Pixi, рантайм CEF или Electron для Linux.
2. **Tauri 3 alpha:** ломающие изменения (выбор рантайма, GTK opt-in), неизвестные сроки стабилизации и размер CEF-сборки.
3. **macOS WKWebView:** WebGPU только с macOS 26. Возможное ограничение 60 Гц в WKWebView ([294338](https://bugs.webkit.org/show_bug.cgi?id=294338)). Старые macOS не получают обновлений WebKit.
4. **Три движка браузера в матрице тестов** (Chromium, WebKit, WebKitGTK) плюс Firefox для веб-сборки. Тестирование дороже, чем у Electron-only.
5. **three.js API меняется ежемесячно.** Переход на WebGPURenderer ломает troika и postprocessing v6. Нужно пинить версии и держать 3D за своим фасадом.
6. **Два движка (Pixi + three)** — два пайплайна иконок и текста. Без общего ассет-слоя (атласы иконок, MSDF-атласы) пойдёт дублирование.
7. **Пиксельная эстетика против плавного зума и дробного DPR.** Пиксельный шрифт размоется в мировом пространстве. Нужна дисциплина «пиксели только в экранном пространстве».
8. **React на горячем пути:** если позиции нод начнут жить в React-состоянии, производительность рухнет. Это архитектурное правило, его нужно записать в ADR.
9. **Свои нити-шейдеры и хит-тест** — ощутимый объём кода (WebGL и WebGPU-варианты, сглаживание, анимация). Это ядро ощущения «как в Houdini», экономить на нём нельзя.
10. **Excalidraw — отдельный мир:** свой Canvas2D, своя тема, React. Стилизация под ретро ограничена (подробно — R5).
11. **CodeMirror переехал с GitHub** на `code.haverbeke.berlin`: issues и PR теперь в другом месте. Небольшой процессный риск.
12. **Лицензии:** Cosmograph (CC-BY-NC-4.0), tldraw (`SEE LICENSE IN LICENSE.md`, npm) и BlockNote XL (GPL-3.0 или проприетарная) несовместимы со свободной лицензией проекта или требуют осторожности. Остальной стек — MIT, Apache-2.0, BSD, ISC, Zlib, CC0, MPL-2.0 — совместим и с MIT, и с AGPL.
13. **Rust в команде:** ответ на B2 не получен. Без Rust-компетенции рекомендация меняется на Electron + Node.

## Открытые вопросы

- **Q-R4-1.** На какой ОС брат работает каждый день? Omarchy в мудборде намекает на Arch + Hyprland (Wayland). Какая видеокарта: встроенная Intel или AMD, NVIDIA? От этого зависит, переживёт ли Tauri на WebKitGTK холст и 3D.
- **Q-R4-2.** Кто пишет код и есть ли опыт Rust (B2)? Это решает выбор между «Tauri + Rust-ядро» и «Electron + Node-ядро».
- **Q-R4-3.** Целевая частота: 60 fps достаточно или нужно 120 на ProMotion и 144-герцовых мониторах? В WKWebView 120 Гц может быть недоступно.
- **Q-R4-4.** Минимальное железо и ОС: поддерживаем macOS до 26 (без WebGPU) и Linux-дистрибутивы со старым WebKitGTK? Допустимо ли, что на слабой машине 3D отключён, а 2D работает через Canvas-фолбэк?
- **Q-R4-5.** Переход 2D↔3D: достаточно «камеры-моста» для текущей сети или нужен непрерывный морф всего пространства?
- **Q-R4-6.** Нужен ли веб-клиенту офлайн-режим без сервера (локальное пространство в браузере через OPFS) или веб = всегда подключение к своему серверу?
- **Q-R4-7.** Допустимо ли, что десктоп-сборка весит 120–150+ МБ (Electron или CEF), если это цена стабильной графики на Linux?
- **Q-R4-8.** Пиксельная эстетика на холсте: только UI и HUD (рекомендация) или «тотальный пиксель-арт» с низким разрешением кадра, ценой детальных гравюрных иконок?
- **Q-R4-9.** Должно ли ядро работать в фоне при закрытом окне (трей), чтобы MCP-агенты имели доступ к пространству всегда?

## Источники

Оболочка и WebView:
- https://github.com/tauri-apps/tauri/blob/dev/README.md
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/Debug/linux-graphics.md (опубликовано: https://v2.tauri.app/develop/debug/linux-graphics/)
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/reference/webview-versions.md
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/start/index.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/concept/process-model.md
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/sidecar.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/learn/sidecar-nodejs.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/updater.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/file-system.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-rust.mdx
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-frontend.mdx
- https://github.com/tauri-apps/tauri/releases/tag/tauri-v3.0.0-alpha.0
- https://github.com/tauri-apps/tauri/releases?q=cef
- https://crates.io/crates/tauri-runtime-cef
- https://github.com/tauri-apps/cef-rs
- https://v2.tauri.app/blog/tauri-20/
- https://www.npmjs.com/package/@tauri-apps/api
- https://github.com/electron/electron/releases/tag/v44.0.0
- https://github.com/electron/electron/releases/tag/v44.7.0
- https://electronjs.org/blog/electron-44-0
- https://electronjs.org/docs/latest/api/utility-process
- https://electronjs.org/docs/latest/api/auto-updater
- https://www.npmjs.com/package/electron
- https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/
- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- https://developer.apple.com/forums/thread/770862
- https://bugs.webkit.org/show_bug.cgi?id=294338
- https://bugs.webkit.org/show_bug.cgi?id=183720
- https://bugs.webkit.org/show_bug.cgi?id=263010
- https://bugs.webkit.org/show_bug.cgi?id=306223
- https://webkitgtk.org/2025/10/24/webkitgtk2.51.1-released.html
- https://webkitgtk.org/2026/02/06/webkitgtk2.51.91-released.html
- https://webkitgtk.org/2026/04/13/webkitgtk2.52.2-released.html
- https://web.dev/articles/files/open-a-directory
- https://github.com/wailsapp/wails/releases
- https://github.com/neutralinojs/neutralinojs
- https://www.i-programmer.info/news/167-javascript/18978-deno-29-adds-desktop-app-builder.html
- https://thenewstack.io/what-is-omarchy-linux-and-why-is-37signals-moving-to-it/

2D:
- https://www.npmjs.com/package/pixi.js
- https://github.com/pixijs/pixijs/blob/main/src/rendering/renderers/autoDetectRenderer.ts
- https://pixijs.com/blog/pixi-v8-launches
- https://pixijs.com/blog/8.7.0
- https://pixijs.com/blog/8.10.0
- https://gamedev.net/news/pixijs-v8200-released-r5221/
- https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap
- https://pixijs.com/8.x/guides/concepts/environments
- https://pixijs.com/8.x/guides/components/application/culler-plugin
- https://pixijs.com/8.x/guides/third-party/mixing-three-and-pixi
- https://forum.obsidian.md/t/what-is-the-tech-stack-currently/833
- https://forum.obsidian.md/t/understanding-the-graph-view-core/41020
- https://reactflow.dev/learn/advanced-use/performance
- https://tldraw.dev/sdk-features/culling
- https://tldraw.dev/blog/tldraw-sdk-4.4
- https://github.com/mourner/rbush
- https://github.com/mourner/flatbush
- https://github.com/Chlumsky/msdf-atlas-gen
- https://github.com/visgl/deck.gl/blob/master/docs/api-reference/layers/text-layer.md
- https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/views.md
- https://www.npmjs.com/package/sigma
- https://www.npmjs.com/package/regl

3D и физика:
- https://www.npmjs.com/package/three
- https://github.com/mrdoob/three.js/releases
- https://threejs.org/manual/en/webgpurenderer
- https://discourse.threejs.org/t/webgpurenderer-forcewebgl-true-vs-webglrenderer/87805
- https://threejs.org/docs/#api/en/objects/InstancedMesh
- https://discourse.threejs.org/t/the-best-approach-to-take-rendering-a-lot-of-meshes-that-can-be-transformed/42134
- https://discourse.threejs.org/t/troika-three-text-and-webgpu/55737
- https://github.com/protectwise/troika/tree/main/packages/troika-three-text
- https://www.npmjs.com/package/three-msdf-text-utils
- https://github.com/pmndrs/text
- https://github.com/pmndrs/postprocessing
- https://www.npmjs.com/package/@babylonjs/core
- https://app.cinevva.com/signals/2026-03-27-browser-rendering-best-month
- https://www.windowsmode.com/babylon-js-9-0-released-build-immersive-3d-web-apps/
- https://github.com/vasturiano/3d-force-graph
- https://github.com/vasturiano/d3-force-3d
- https://github.com/anvaka/ngraph.forcelayout
- https://github.com/cosmosgl/graph
- https://www.npmjs.com/package/@cosmos.gl/graph
- https://www.npmjs.com/package/@cosmograph/cosmograph
- https://www.npmjs.com/package/@cosmograph/cosmos
- https://openjsf.org/blog/introducing-cosmos-gl
- https://openjsf.org/blog/cosmos-gl-v3
- https://unpaywall.org/10.2312%2FPGV.20221067
- https://www.npmjs.com/package/three-mesh-bvh

UI и редактор:
- https://www.npmjs.com/package/react
- https://www.npmjs.com/package/babel-plugin-react-compiler
- https://www.npmjs.com/package/svelte
- https://www.npmjs.com/package/solid-js
- https://www.npmjs.com/package/@excalidraw/excalidraw
- https://www.npmjs.com/package/@pixi/react
- https://www.npmjs.com/package/@react-three/fiber
- https://www.npmjs.com/package/@threlte/core
- https://www.npmjs.com/package/obsidian
- https://github.com/codemirror/view
- https://docs.obsidian.md/Plugins/Editor/Decorations
- https://docs.obsidian.md/Plugins/Editor/Viewport
- https://codemirror.net/examples/million
- https://github.com/segphault/codemirror-rich-markdoc
- https://www.npmjs.com/package/y-codemirror.next
- https://tiptap.dev/docs/conversion/export/markdown/editor-extension
- https://tiptap.dev/docs/resources/changelog/markdown
- https://www.npmjs.com/package/@tiptap/markdown
- https://www.npmjs.com/package/@milkdown/core
- https://github.com/remarkjs/remark/tree/main/packages/remark-stringify
- https://www.blocknotejs.org/docs/features/export/markdown
- https://www.npmjs.com/package/@blocknote/core
- https://www.npmjs.com/package/@blocknote/xl-ai
- https://www.npmjs.com/package/tldraw

Ядро:
- https://github.com/rusqlite/rusqlite
- https://github.com/notify-rs/notify
- https://github.com/quickwit-oss/tantivy
- https://github.com/quickwit-oss/tantivy/blob/main/src/tokenizer/stemmer.rs
- https://crates.io/crates/rmcp
- https://github.com/modelcontextprotocol/rust-sdk
- https://github.com/Spxg/sqlite-wasm-rs
- https://github.com/rhashimoto/wa-sqlite
- https://sqlite.org/wasm/doc/trunk/persistence.md
- https://www.npmjs.com/package/better-sqlite3
- https://www.npmjs.com/package/@sqlite.org/sqlite-wasm
- https://www.npmjs.com/package/@modelcontextprotocol/sdk
- https://www.npmjs.com/package/@parcel/watcher
- https://www.npmjs.com/package/chokidar
- https://crates.io/crates/loro
- https://crates.io/crates/yrs
