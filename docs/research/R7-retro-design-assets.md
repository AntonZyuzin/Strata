# R7. Визуальные ассеты: пиксельные шрифты, ретро-окна, гравюрные иконки, туманные фоны

> Дата исследования: 2026-10-13. Лицензии прочитаны в файлах `LICENSE`/`OFL.txt` самих репозиториев (GitHub raw, git). Версии пакетов взяты из npm registry и тегов git в тот же день. **Кириллица проверялась не по описаниям, а по таблицам `cmap` файлов шрифтов** (fontTools 4.66). Проверяемый набор: 66 букв русского алфавита (А–Я, а–я, Ё, ё), знаки `«»—–…№` и украинско-белорусские `ЄІЇҐЎ`. Сайты game-icons.net, int10h.org, kenney.nl, gamedeveloper.com, polyhaven.com, unsplash.com, developer.mozilla.org и w3.org из среды напрямую не открывались. Тексты MDN и WCAG прочитаны в их исходных репозиториях на GitHub (`mdn/content`, `mdn/browser-compat-data`, `w3c/wcag`). Остальное взято из выдачи поиска и помечено «по данным поиска». Замеры сделаны на Node 22, Xeon 2,8 ГГц, в один поток.
>
> Обозначения: ✅ решено ответами владельца (ссылка на вопрос), 💡 предложение, ❓ вопрос. Термины — по [глоссарию](../glossary.md), модель данных — [05-domain-model.md](../05-domain-model.md). Рендер — по [R4](R4-app-shell-rendering.md).

## Кратко

- **У половины «модных» пиксельных шрифтов нет кириллицы, а Pixelify Sans — ловушка.** По `cmap` полный русский алфавит есть у Press Start 2P 3.000, Tiny5 2.007, Departure Mono 1.500, Monocraft 4.2, Pixel Code 2.2, Handjet 2.003, Rubik Pixels, DotGothic16, Spleen 2.2.0 (кроме 5×8), Cozette, Fixedsys Excelsior, unscii и Unifont. Кириллицы нет у Silkscreen, Jersey 10–25, Micro 5, VT323, Sixtyfour, Workbench, Bytesized, Doto, Bitcount, Geist Pixel (`geist` 1.7.2) и у шрифта MS Sans Serif из 98.css. **Pixelify Sans 1.000** в метаданных Google Fonts заявляет кириллицу, но в нём нет заглавных **О, П** и **І** (U+041E, U+041F, U+0406). Набрать «ПРОЕКТ» этим шрифтом нельзя.
- **Связка шрифтов:** Press Start 2P для заголовков окон (сетка 8 px), Departure Mono для интерфейса (сетка 11 px), Golos Text для длинных заметок, JetBrains Mono для кода. Все четыре — SIL OFL 1.1, все с полной кириллицей, «№» и «ёлочками». Tiny5 — запасной пропорциональный пиксельный шрифт для UI.
- **Пиксельный шрифт чёткий только при целом числе физических пикселей на пиксель шрифта.** `-webkit-font-smoothing: none` работает только на macOS ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth)). При DPR 1,25 и 1,5 кегль приходится считать от физических пикселей. Отсюда 💡 правило «пиксельной единицы» и запрет пиксельного текста в масштабируемом мировом пространстве (продолжение правила из R4).
- **Ретро-киты — справочник техник, а не зависимость.** Двойные `inset`-тени для фасок, синий заголовок окна, точечный фокус берём из 98.css (MIT). Но 98.css тянет шрифт MS Sans Serif под CC BY-SA 3.0 без кириллицы. В репозитории system.css лежит `monaco.woff`. В LICENSE React95 прямо сказано, что изображения Windows — собственность Microsoft.
- **Иконки «под Мор».** Ближе всего по духу game-icons.net: 4133 детальных силуэта, CC BY 3.0, 36 авторских папок в репозитории. Лицензия требует строку «Icons made by {author}», то есть нужен экран благодарностей с поштучной атрибуцией. Пиксельный слой — Pixelarticons (1036 бесплатных иконок, MIT, сетка 24). Подвох: у HackerNoon Pixel Icon Library в npm указан MIT, а сами иконки по README идут под CC BY 4.0.
- **Свои иконки проходят через конвейер «привести к стилю».** SVG санитизируется (DOMPurify), растр строится в воркере, затем порог Otsu, Atkinson, Floyd–Steinberg или Bayer (`@thi.ng/pixel-dither`, Apache-2.0, около 1 КБ). На выходе — 1-битная маска в трёх размерах. Дизеринг картинки 512×512 занимает 9–12 мс, то есть при загрузке его не заметно.
- **Фон размываем один раз, на уменьшенной копии.** StackBlur на 480×270 с радиусом 8 занимает 6,6 мс, на 4K с радиусом 60 — 581 мс. 💡 Яркость фона нормализуем: относительная яркость не выше 0,10 (95-й перцентиль). Тогда бабл контрастирует с фоном 6:1, а нить с альфой 60 % — не меньше 3,3:1. Пресеты делаем процедурными или из CC0-источников (Poly Haven, Met Open Access, NASA). Фото с Unsplash и Pexels в поставку не кладём.
- **Чему учит «Мор».** Важность передаётся размером, неактивность — прозрачностью, будущее — пунктиром (у нас это призраки). Жёлтый означает «внимание», а не упрёк. Один кружок обновляется вместо того, чтобы растить цепочку. Всё это переведено в таблицу состояний бабла (раздел «Рекомендация», п. 4). Каждое состояние там кодируется не только цветом, но и формой или значком (WCAG 1.4.1).

## Находки

### 1. Пиксельные и растровые шрифты

#### 1.1. Как проверялось

Метаданные Google Fonts (`METADATA.pb`, поле `subsets`) иногда расходятся с содержимым файла. Поэтому для каждого шрифта скачан сам файл: из `google/fonts`, из репозитория автора или из npm. Затем по `cmap` посчитаны:

- **RU** — сколько из 66 букв русского алфавита есть в шрифте;
- **блок** — сколько знаков из блока Cyrillic U+0400–U+052F;
- наличие `«»—–…№` и `ЄІЇҐЎ`.

**Родной кегль** вычислен как `UPM / НОД координат контуров`. Например, у Press Start 2P UPM 1000 и шаг 125, значит пиксель шрифта равен 1/8 em. Чётко такой шрифт выглядит на кеглях 8, 16, 24 px.

#### 1.2. Шрифты с кириллицей (проверено по файлу)

| Шрифт | Версия, источник | Лицензия (файл) | RU / блок | Нет из набора | Родная сетка | Заметки |
|---|---|---|---|---|---|---|
| **Press Start 2P** | 3.000, Google Fonts (добавлен 2012-04-04) | OFL 1.1, Reserved Font Name «Press Start 2P» ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/pressstart2p/OFL.txt)) | 66 / 184 | — | 8 px (UPM 1000, шаг 125) | Широкий «аркадный» моноширинный. README NES.css утверждает, что шрифт «only supports English» ([README](https://github.com/nostalgic-css/NES.css)). Это устарело: в 3.000 кириллица полная |
| **Tiny5** | 2.007, Google Fonts (2024-04-19), автор Stefan Schmidt ([upstream](https://github.com/Gissio/font_tiny5)) | OFL 1.1 ([OFL.txt](https://github.com/google/fonts/blob/main/ofl/tiny5/OFL.txt)) | 66 / 240 | — | 8 px (UPM 1024, высота прописных 640 = 5 пикселей) | Пропорциональный. Вариативный: `wght` 100–900, `wdth` 50–200, `ROND`, `BLED`, `JITT` (скругление, «растекание», дрожание). Есть армянский, греческий, вьетнамский |
| **Departure Mono** | 1.500, последний коммит 2025-05-25 ([repo](https://github.com/rektdeckard/departure-mono)) | Шрифт — OFL 1.1, © 2022–2024 Helena Zhang ([public/assets/LICENSE](https://github.com/rektdeckard/departure-mono/blob/main/public/assets/LICENSE)). Корневой `LICENSE` (MIT) относится к сайту | 66 / 216 | — | 11 px (UPM 550, шаг 50) | README: «For pixel-perfect results, set the font size to increments of 11px». Моноширинный, «технический» вид |
| **Monocraft** | 4.2 (тег v4.2.1), коммит 2026-05-27 ([repo](https://github.com/IdreesInc/Monocraft)) | OFL 1.1 | 66 / 158 | `№` | 9 px (UPM 1080, шаг 120) | Стилистика Minecraft, лигатуры для кода |
| **Pixel Code** | 2.2, коммит 2026-09-23 ([repo](https://github.com/qwerasd205/PixelCode)) | OFL 1.1 | 66 / 96 | `№`, `Ґґ` | 9 px (UPM 1008, шаг 112) | Для кода; 20 файлов OTF (10 весов, у каждого курсив) |
| **Handjet** | 2.003, Google Fonts, Rosetta / David Březina ([upstream](https://github.com/rosettatype/Handjet/)) | OFL 1.1 | 66 / 182 | — | Модульная сетка из «элементов» | Вариативный: `wght`, `ELGR` 1–2 (сетка элементов), `ELSH` 0–16 (форма элемента: квадрат, круг и т. д.). Есть арабский, иврит, греческий, армянский. Хорош для дисплейных надписей |
| **Rubik Pixels** | 2.200, Google Fonts | OFL 1.1 | 66 / 182 | — | Нет (буквы Rubik, «залитые» пикселями) | Декоративный, на 24 px шумит (проверено рендером). Только для крупных заголовков |
| **DotGothic16** | 1.100, Google Fonts, Fontworks | OFL 1.1 | 66 / 66 | `ЄІЇҐЎ` | 16-точечная японская гарнитура | Широкие разрядки, 2 МБ из-за японского |
| **Pixelify Sans** | 1.000, Google Fonts (2023-09-13). Upstream не менялся с 2023-10-12 ([repo](https://github.com/eifetx/Pixelify-Sans)) | OFL 1.1, **без** Reserved Font Name | **64 / 91** | **О, П, І** | Не строгая сетка (вариативный `wght` 400–700) | ❌ Брак: в `cmap` и в наборе глифов нет `uni041E` и `uni041F`. Тот же дефект в сборке upstream (`fonts/ttf/PixelifySans-Regular.ttf`). Использовать можно только после исправления. RFN нет, поэтому форк с дорисовкой разрешён |
| **Spleen** | 2.2.0 (2026-02-01) ([ChangeLog](https://github.com/fcambus/spleen/blob/master/ChangeLog)) | BSD-2-Clause ([LICENSE](https://github.com/fcambus/spleen/blob/master/LICENSE)) | 66 / 74 в 6×12, 8×16, 12×24, 16×32, 32×64; 0 в 5×8 | Нет `№`, нет `Є`. В 6×12 нет тире | Растровый: 5×8 … 32×64 | Кириллица («basic alphabet + most used extended») появилась в 2.1.0 (2024-03-22). README об этом не пишет. Релизы содержат OTF, WOFF, WOFF2 ([README](https://github.com/fcambus/spleen)) |
| **Cozette** | 2.0.0 ([repo](https://github.com/the-moonwitch/Cozette), коммит 2026-08-14) | MIT | 66 / 297 | — | 6×13 (растр) | README: векторная версия «doesn't look right at any size», нужен `.otb`. В вебе нужен вектор, поэтому для Strata подходит плохо |
| **Fixedsys Excelsior** (форк kika/fixedsys) | коммит 2026-02-20 ([repo](https://github.com/kika/fixedsys)) | Public domain / CC0 («released it to the public domain… Creative Commons Zero») | 66 / 262 | — | 8×16 | Классический «виндовый» терминал, есть лигатуры |
| **unscii** | коммит 2021-02-24 ([repo](https://github.com/viznut/unscii)) | Public domain / CC0, кроме `*-full` (GPL, производные от Unifont) | 66 / 88 | `№`, `ЄҐЎ` | 8×8, 8×16 | Проект заброшен |
| **Ark Pixel** | тег 2026.09.25 ([repo](https://github.com/TakWolf/ark-pixel-font)) | OFL 1.1 (шрифт) + MIT (код сборки) | 153 из 256 знаков блока Cyrillic в 10 и 12 px (по [docs/info-*.md](https://github.com/TakWolf/ark-pixel-font/blob/master/docs/info-12px-proportional.md)). Полноту русского алфавита по `cmap` не проверял | — | 10, 12 px | Размер 16 px упразднён: последняя сборка с ним — 2026.09.01. Автор советует вместо него Unifont |
| **Fusion Pixel** | тег 2026.09.25 ([repo](https://github.com/TakWolf/fusion-pixel-font)) | OFL 1.1 | 10 и 12 px: 153/256. В 8 px строки Cyrillic в статистике нет | — | 8, 10, 12 px | Ориентирован на CJK, тяжёлый |
| **GNU Unifont** | 17.0.03 (2025-11-01) по данным [Википедии](https://en.wikipedia.org/wiki/GNU_Unifont); релиз 2026 года не проверен | GPL-2.0+ с font embedding exception **или** OFL 1.1 (двойная лицензия с 13.0.04) ([unifoundry](https://unifoundry.com/unifont/), по данным поиска) | Полный Unicode BMP | — | 8×16 / 16×16 | Утилитарный, «системный» вид. Годится как пиксельный фолбэк для любых символов |
| **Terminus** | 4.49.1 ([сайт](https://terminus-font.sourceforge.net/), по данным поиска) | OFL 1.1 с RFN «Terminus Font» с версии 4.49 (по данным поиска, [Debian copyright](https://metadata.ftp-master.debian.org/changelogs//main/x/xfonts-terminus/xfonts-terminus_4.48-3_copyright)) | ISO 8859-5, KOI8-R/U (по данным поиска) | не проверено | Растр, 6×12 … 16×32 | Для веба нужна TTF-конвертация (Terminus TTF). Не проверено |
| **Ultimate Oldschool PC Font Pack** (PxPlus) | 2.2 (2020-11-21) | CC BY-SA 4.0 ([SUSE](https://packagehub.suse.com/packages/int10h-oldschoolpc-fonts), [FreshPorts](https://www.freshports.org/x11-fonts/oldschool-pc-fonts), по данным поиска) | В 23 шрифтах PxPlus около 780 знаков, кириллица взята из локализованных ROM ([readme](https://int10h.org/oldschool-pc-fonts/readme/), по данным поиска). По `cmap` не проверено | — | Родные растры VGA, EGA и других адаптеров | Самая «честная» эстетика DOS и BSOD. Но ShareAlike: изменённый шрифт (в том числе, возможно, подмножество WOFF2) остаётся под CC BY-SA |

#### 1.3. Пиксельные шрифты без кириллицы (не берём для текста)

| Шрифт | Версия | Проверка |
|---|---|---|
| Silkscreen | 1.001 | `cmap`: 0/66, `subsets`: latin, latin-ext |
| Jersey 10 / 15 / 20 / 25 | 1.001 | `cmap` (Jersey 10): 0/66; у всех `subsets` без cyrillic |
| Micro 5 | 1.001 | `cmap`: 0/66 |
| VT323 | 2.000 | `cmap`: 0/66 |
| Doto, Bytesized | 1.000 | `cmap`: 0/66 |
| Sixtyfour, Workbench, Jacquard 12/24, Jacquarda Bastarda 9, Bitcount | — | `subsets` без cyrillic (не проверено по `cmap`) |
| Geist Pixel (Square, Circle) | `geist` 1.7.2 (npm, 2026-06-01), OFL; выпущен 2026-02-06 ([блог Vercel](https://vercel.com/blog/introducing-geist-pixel), по данным поиска) | `cmap`: 0/66. При этом Geist Mono 1.700 из того же пакета — 66/66 |
| «Pixelated MS Sans Serif» из 98.css | — | 95 знаков, кириллицы нет. CC BY-SA 3.0, FontStruction автора «lou» ([license.txt](https://github.com/jdan/98.css/blob/main/fonts/src/ms-sans-serif/license.txt)) |

#### 1.4. Читаемые шрифты для длинного текста

| Шрифт | Версия (Google Fonts) | Лицензия | RU / блок | `ЄІЇҐЎ`, `№` | Роль |
|---|---|---|---|---|---|
| **Golos Text** | 2.004, `wght`; дизайнеры Alexandra Korolkova, Vitaly Kuzmin | OFL 1.1 | 66 / 172 | Да | Проза в заметках, интерфейс в «читаемом режиме» |
| Onest | 2.001, `wght` | OFL 1.1 | 66 / 162 | Да | Альтернатива Golos, чуть геометричнее |
| Inter | 4.001, `opsz` + `wght` | OFL 1.1 | 66 / 249 | Да | Максимальное покрытие, нейтральный |
| **JetBrains Mono** | 2.211, `wght` | OFL 1.1 | 66 / 98 | Да | Код, моноширинный режим заметок |
| IBM Plex Mono / Sans | 2.3 | OFL 1.1, RFN «Plex» | 66 / 168 | Да | «Машинописный» вариант |
| Geist Mono | 1.700 (npm `geist` 1.7.2) | OFL 1.1 | 66 / 134 | Да | Альтернатива JetBrains Mono |
| PT Sans / PT Mono | Google Fonts, ParaType | OFL 1.1 | `subsets` cyrillic, cyrillic-ext | — | Классика для кириллицы (не проверено по `cmap`) |

Все шрифты из таблицы, кроме Departure Mono, есть в Fontsource для самостоятельного хостинга: `@fontsource/press-start-2p` 5.3.0, `@fontsource/tiny5` 5.3.0, `@fontsource/handjet` 5.3.1, `@fontsource/golos-text` 5.3.0, `@fontsource/jetbrains-mono` 5.3.0, `@fontsource/onest` 5.3.1 — все OFL-1.1 (npm registry). Departure Mono в Fontsource нет (запрос к registry вернул пустой ответ), его кладём в сборку из репозитория автора. Для офлайн-десктопа (R4) это обязательно: никаких Google Fonts CDN.

Образец набора (рендер с помощью Pillow) подтвердил данные по `cmap`. В Pixelify Sans на месте «П» стоит пустой прямоугольник. Monocraft и Pixel Code показывают «□» вместо «№». Rubik Pixels на 24 px читается плохо.

### 2. Как пиксельные шрифты рендерятся в вебе

- **Сглаживание отключить нельзя.** `font-smooth` нестандартный. `-webkit-font-smoothing` и `-moz-osx-font-smoothing` «only works on macOS» ([MDN font-smooth](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth)). На Windows и Linux векторный пиксельный шрифт выглядит чётким, только когда граница каждого пикселя шрифта совпадает с границей физического пикселя.
- **Отсюда кегли кратны родной сетке**: Departure Mono — 11/22/33 px, Press Start 2P и Tiny5 — 8/16/24 px, Monocraft и Pixel Code — 9/18/27 px ([Kirupa](https://www.kirupa.com/hodgepodge/preserving_pixel_art_aesthetics.htm), README Departure Mono). Глифы нельзя ставить на дробные координаты: Firefox тогда смешивает краевые пиксели ([observe-ui notes](https://code.querie.cc/mirrors/code-piaforge-com/observe-ui/plain/notes/README_PIXEL_FONTS.md), по данным поиска).
- **Дробный DPR.** При масштабе 125 % 16 CSS px — это 20 физических пикселей, то есть 2,5 физических на пиксель Press Start 2P. Получается мыло. Кегль надо считать так: `css_px = k × native / DPR`, где `k` — целое. При 125 % для Departure Mono это 22 × 1 / 1,25 = 17,6 CSS px → 22 физических пикселя. 💡 Отсюда «пиксельная единица» `u = max(1, round(DPR))` физических пикселей. В единицах `u` задаются рамки, фаски и кегли; JS выставляет `--u` в CSS px и пересчитывает при `matchMedia('(resolution: …)')`.
- **Растровые картинки** (иконки 16/24 px, узоры) масштабируются с `image-rendering: pixelated`. По MDN это ближайший сосед до ближайшего целого кратного, а дальше сглаживание. Так пиксели остаются квадратными без артефактов при нецелом масштабе ([MDN image-rendering](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering)).
- **На холсте (PixiJS)** R4 уже зафиксировал: `textureStyle: { scaleMode: 'nearest' }` и правило «пиксельный шрифт только в экранном пространстве». Подписи баблов в мировом пространстве набираются MSDF ([R4 §2.7](R4-app-shell-rendering.md)).

### 3. Ретро-UI-киты

| Кит | Версия, дата (npm) | Лицензия | Активность | Что брать | Что не брать |
|---|---|---|---|---|---|
| [98.css](https://github.com/jdan/98.css) | 0.1.21 (2025-04-28), последний коммит 2025-09-07 | MIT | Живой, но медленный | Фаски на двух-трёх слоях `box-shadow: inset` (`--border-raised-outer/inner`, `--border-sunken-*`, `--border-window-*`); токены `--surface #c0c0c0`, `--dialog-blue #000080`, `--button-shadow #808080`; фокус `outline: 1px dotted; outline-offset: -4px`; семантический HTML без JS | Шрифт «Pixelated MS Sans Serif» (CC BY-SA 3.0, без кириллицы); точную копию Windows 98 |
| [XP.css](https://github.com/botoxparty/XP.css) | 0.2.6 (2022-10-25) | MIT | Застой | — | Эстетика Luna не наша |
| [7.css](https://github.com/khang-nd/7.css) | 0.21.1 (2025-07-27) | MIT | Живой | — | Aero, стекло и блюр противоречат «жёстким рамкам без размытия» из мудборда |
| [system.css](https://github.com/sakofchit/system.css) | `@sakun/system.css` 0.1.11 (2023-03-18) | MIT (код) | Застой | Классический Mac: штриховка заголовка окна, 1-битные узоры, тени-смещения | Шрифты: README называет Chicago и Geneva «recreations by @blogmywiki». В репозитории лежит `fonts/monaco.woff` — по имени это Monaco от Apple, лицензия файла не указана (не проверено) |
| [NES.css](https://github.com/nostalgic-css/NES.css) | 2.3.0 (2019-12-17) | MIT | Мёртв | Пиксельные рамки через `box-shadow`-«лесенку», пиксельные иконки на CSS | Зависимость |
| [React95](https://github.com/React95/React95) (`@react95/core`) | 9.8.5 (2026-10-08); `@react95/icons` 2.5.3 | MIT. В LICENSE: «Windows and all associated images are the property of the Microsoft Corp and are not covered by this license» | Активный | Структура компонентов (окно, меню, таскбар) | Иконки Windows 95 из `@react95/icons` — чужая торговая марка |
| `react95` ([arturbien/React95](https://github.com/arturbien/React95)) | 4.0.0 (2022-11-13) | MIT | Застой; peer `styled-components` | — | Лишняя зависимость от styled-components |
| [WebTUI](https://github.com/webtui/webtui) (`@webtui/css`) | 0.1.10 (2026-08-12) | MIT | Активный | Терминальная сетка, псевдографика рамок | Для «окон» не подходит |
| [BOOTSTRA.386](https://github.com/kristopolous/BOOTSTRA.386) | — | Apache-2.0 | Застой | Палитра DOS и BSOD как идея | Bootstrap 2 |

Вывод. Своя мини-библиотека окон Strata (DOM + CSS, R4) в 300–500 строк CSS дешевле и безопаснее любой из перечисленных зависимостей. Из 98.css берём технику фасок и фокуса, из system.css — 1-битные узоры и штриховку заголовка, из мудборда — инверсные плашки-заголовки и пунктирные разделители. Палитры (BSOD `#0000AA`, ч/б, розовый dinolab) задаются токенами темы.

**Доступность ретро-китов** (вывод по коду 98.css):
- серое на сером: текст `#222` на `#c0c0c0` даёт около 9:1, и это нормально. Но неактивный текст и тени `#808080` на `#c0c0c0` — около 2,2:1;
- фокус пунктиром в 1 px слабо заметен (ср. [WCAG 2.4.13 Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html));
- контролы мелкие: чекбокс 13 px, радио 12 px. Меньше 24×24 из [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), если не добавить отступы;
- кегль 11 px без масштабирования.

Всё это исправимо токенами, но копировать «как есть» нельзя.

### 4. Иконки

#### 4.1. game-icons.net — основной кандидат для «гравюрного» стиля

- **Лицензия** ([license.txt](https://github.com/game-icons/icons/blob/master/license.txt)): «Icons provided under the Creative Commons 3.0 BY or CC0 if mentioned below». Под CC0 только авторы Viscious Speed и Zeromancer. Требование: «Please, include a mention „Icons made by {author}“ in your derivative work». Коммерческое использование разрешено ([Iconify](https://icon-sets.iconify.design/game-icons/bandit), по данным поиска).
- **Объём.** В репозитории 4239 SVG (с папкой `badges`, 59 штук), последний коммит 2026-04-23 («add 11 tarot icons»). Больше всего иконок у Delapouite (2022) и Lorc (1429), дальше Skoll (172), Caro Asercion (127), Viscious Speed (121), Sbed (95). В Iconify-пакете `@iconify-json/game-icons` 1.2.4 (2026-04-24) — 4133 иконки, лицензия CC-BY-3.0.
- **Формат.** В репозитории это 512×512, чёрный квадрат-фон (`<path d="M0 0h512v512H0z"/>`) и белый силуэт. В Iconify-JSON — один `path` с `fill="currentColor"` без фона. **Поавторской разметки в Iconify-JSON нет**, авторство берём из структуры папок репозитория при сборке.
- **Насколько похоже на «Мор».** Это детальные силуэты с внутренней прорисовкой (Lorc — почти гравюрная штриховка), белое на чёрном, тематика «предметы, анатомия, алхимия, оружие, символы». Для бабла «белый круг + чёрная иконка» силуэт просто инвертируется. Сама штриховка в иконках не гравюрная. Её можно добавить шейдером `CrossHatchFilter` (pixi-filters), но это дорого и выглядит как фильтр. Лучше — отдельный набор настоящих гравюр (4.3).
- **Что значит CC BY 3.0 для Strata.**
  - Нужен экран «Благодарности» со списком авторов использованных иконок и ссылкой на лицензию. В подсказке пикера иконок стоит показывать «© Lorc, CC BY 3.0».
  - Перекраска и инверсия — вероятно, тривиальная адаптация. Но для CC BY 3.0 при адаптации нужно по возможности указать, что работа изменена (раздел 4(b) лицензии; не юридическая консультация).
  - Иконки в данных пространства храним как ссылку на пресет (`game-icons/lorc/ace`), а не копией файла. Тогда при экспорте атрибуция не теряется.

#### 4.2. Пиксельные наборы

| Набор | Версия, дата | Иконок | Лицензия (проверено) | Сетка | Комментарий |
|---|---|---|---|---|---|
| [Pixelarticons](https://github.com/halfmage/pixelarticons) | 2.4.2 (2026-10-06) | **1036** бесплатных; полный платный набор — 5497 (октябрь 2026) | MIT (LICENSE и README: «Every icon stays MIT licensed») | 24×24, «no anti-aliasing, pure `<path>`», `currentColor` | Чёткие на 24/48/72/96 px (README). Лучший кандидат для UI-хрома |
| [HackerNoon Pixel Icon Library](https://github.com/hackernoon/pixel-icon-library) | 1.1.0 (2026-04-13) | 578 уникальных (248 regular + 248 solid + 59 brands + 23 purrcats) | **Иконки — CC BY 4.0** («You must give appropriate credit…»), остальные файлы — MIT. В npm поле `license` = MIT, это вводит в заблуждение | 24 | Требует атрибуции. Либо платная лицензия ([pixeliconlibrary.com/license](https://pixeliconlibrary.com/license/)) |
| Streamline Pixel (free, Iconify `streamline-pixel`) | — | 662 | CC BY 4.0 (Iconify info.json) | 32 | Требует атрибуции |
| [Kenney 1-Bit Pack](https://opengameart.org/content/1-bit-pack) | — | 1000+ тайлов, персонажей и предметов | CC0, «credit is not mandatory» (по данным поиска) | Тайлы, вероятно 16×16 (не проверено) | Игровая тематика. Годится для «пасхалок» и курсоров |

#### 4.3. Настоящие гравюры из общественного достояния

Для пресет-набора «Гравюры», который ближе всего к референсу владельца (✅ I1: «детальные гравюрные иконки»), нужны исходники XVIII–XIX веков:

- **The Met Open Access**: с февраля 2017 года CC0, «over 492,000 images» произведений в общественном достоянии ([metmuseum.org](https://www.metmuseum.org/hubs/open-access), по данным поиска). Гравюры, ботанические и анатомические листы.
- **Old Book Illustrations**: иллюстрации в основном PD в США и ЕС с оговорками по году смерти автора. Тексты сайта — CC BY-NC-SA 4.0 ([вторичная цитата условий](https://huggingface.co/datasets/gigant/oldbookillustrations/commit/e3d786d9d384232e7961c6303a9b5dba95ed8758), по данным поиска). Статус каждой картинки проверяется отдельно.
- **Wellcome Collection** (Public Domain Mark на старых гравюрах, [пример](https://content.wellcomecollection.org/works/bpv75u4v), по данным поиска).

Производство: отобрать 100–200 мотивов (книга, ключ, сердце, глаз, часы, компас, дом, человек, дерево, письмо и т. д.), кадрировать в круг и прогнать через тот же конвейер стилизации (4.6). Порог и лёгкий unsharp дают ту самую «гравюрную» линию. Работа для дизайнера или куратора на 2–4 дня. Это ❓ вопрос I8.

#### 4.4. Запасные контурные наборы (для «читаемого режима» и служебного UI)

| Набор | Версия | Иконок (Iconify) | Лицензия |
|---|---|---|---|
| [Phosphor](https://github.com/phosphor-icons/core) | `@phosphor-icons/core` 2.1.1 (2024-03-29) | 9072 (6 начертаний) | MIT |
| [Tabler](https://github.com/tabler/tabler-icons) | 3.49.0 (2026-10-05) | 6238 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | `lucide-static` 1.56.0 (2026-10-13) | 1877 | ISC |
| [Iconoir](https://github.com/iconoir-icons/iconoir) | — | — | MIT |

Стилистически они чужие «Мору» и ретро. Нужны только как фолбэк для иконок интерфейса в «читаемом режиме». Phosphor с его 6 начертаниями — самый гибкий.

#### 4.5. Пользовательские иконки: форматы и безопасность

| Формат | Как принимаем | Подводные камни |
|---|---|---|
| PNG, JPEG, WebP, AVIF | `createImageBitmap` в воркере → `OffscreenCanvas` | Ограничить размер, например ≤ 10 МБ и ≤ 4096×4096. EXIF-ориентация |
| **SVG** | Санитизация через [DOMPurify](https://www.npmjs.com/package/dompurify) 3.4.17 (2026-10-12, MPL-2.0 OR Apache-2.0) с SVG-профилем: без `<script>`, `foreignObject`, внешних `href`, обработчиков `on*`. Затем растеризация через `<img>` или `Image` (скрипты там не исполняются) | Никогда не вставлять пользовательский SVG в DOM напрямую — это XSS, особенно на общем сервере с командой. Оригинал храним как ассет по хешу (05 §ассеты), рендерим только растровые производные |
| **GIF (анимация)** | `ImageDecoder` (WebCodecs) там, где он есть: Chrome 94+, Firefox 133+. В Safari — только Technology Preview ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/ImageDecoder.json)). Фолбэк — [gifuct-js](https://www.npmjs.com/package/gifuct-js) 2.1.2 (MIT, последний релиз 2021) | WebKit — это и Safari, и Tauri на macOS и Linux (R4), поэтому фолбэк обязателен. Анимацию играем только при наведении и выделении; при `prefers-reduced-motion` её нет. Число кадров ограничиваем |
| Эмодзи | Рендер системного эмодзи-шрифта в canvas → тот же конвейер (порог) | Вид зависит от ОС. Без стилизации цветные эмодзи ломают монохром холста |

#### 4.6. Автостилизация: порог и дизеринг в браузере

**Алгоритмы:**

| Алгоритм | Вид | Применение в Strata |
|---|---|---|
| Порог (threshold, авто-порог Otsu) | Чистый силуэт, «гравюра» без полутонов | Режим «Гравюра» по умолчанию для фото и рисунков. Ползунок порога |
| Atkinson | Локальный, высококонтрастный, рассеивает только 3/4 ошибки ([Википедия](https://en.wikipedia.org/wiki/Atkinson_dithering)). Светлые области «выгорают» | Режим «Мак-1984» для фото-иконок. Лучше всего читается в маленьком кружке |
| Floyd–Steinberg (и Jarvis, Stucki, Sierra) | Мягкие полутона, «шум» | Режим «Фото» для крупных обложек и медиа-нод |
| Ordered / Bayer 4×4, 8×8 | Регулярная сетка, «крест-накрест» | Режим «Пиксель». Единственный вариант, стабильный при анимации и постпроцессе |
| Blue noise | Органичнее Bayer, но маски нужно считать заранее (void-and-cluster) | Постпроцесс в 3D (п. 5.3) |

Хорошие разборы: [Ditherpunk](https://surma.dev/things/ditherpunk/) (Surma) и девлог Lucas Pope о стабильном дизеринге в Return of the Obra Dinn (п. 5.3).

**Библиотеки:**

| Пакет | Версия, дата | Лицензия | Что умеет |
|---|---|---|---|
| [`@thi.ng/pixel-dither`](https://github.com/thi-ng/umbrella/tree/develop/packages/pixel-dither) | 1.1.206 (2026-08-25) | Apache-2.0 | Atkinson, Bayer (ordered, настраиваемый размер), Burkes, Diffusion, Floyd–Steinberg, Jarvis–Judice–Ninke, Sierra 2-row, Stucki, Threshold. ESM около 1,06 КБ (brotli). Работает с буферами `@thi.ng/pixel` 7.5.38 |
| [`image-q`](https://github.com/ibezkrovnyi/image-quantization) | 4.0.0 (2022-01-08) | MIT | Квантизация палитры (NeuQuant, RGBQuant, WuQuant) и диффузия ошибки (9 ядер, Riemersma). Ordered-дизеринга нет. Нужен для режима «N цветов», а не для 1 бита |
| [`imagetracerjs`](https://www.npmjs.com/package/imagetracerjs) | 1.2.6 (2020) | Unlicense | Растр → SVG. Пригоден для векторизации 1-битной маски |
| `potrace`, `esm-potrace-wasm` | 2.1.8 / 0.5.1 (2026-08-14) | **GPL-2.0** | Лучшая векторизация, но GPL. Брать только если лицензия Strata совместима (❓ B, лицензия не выбрана) |
| `@imgly/background-removal` | 1.7.0 (2025-07-18) | **AGPL-3.0** (LICENSE.md в пакете) | Удаление фона нейросетью. AGPL заражает сервер, не брать |

**Замеры** (`@thi.ng/pixel-dither`, 8-битный серый, Node 22):

| Операция | 128×128 | 512×512 |
|---|---|---|
| Atkinson | 2,7 мс | 11,6 мс |
| Floyd–Steinberg | 0,6 мс | 9,5 мс |
| Bayer 8×8 | — | 8,5 мс |

Это стоимость одной операции при загрузке. В воркере она незаметна, и предпросмотр с ползунком можно пересчитывать «вживую».

**Удаление фона без нейросетей.** У картинки с альфой используем альфу. У непрозрачной — заливка от углов по цвету угла с допуском плюс ручная «кисть-ластик» в диалоге. Этого хватает для логотипов, клипарта и сканов гравюр.

### 5. Фоны и эффекты

#### 5.1. Размытие

- **Живой блюр дорог.** `backdrop-filter` и большие `filter: blur()` перерисовываются каждый кадр, если фон под ними меняется. Prysm прямо пишет, что такие элементы «redraws every frame» ([Coherent Labs](https://docs.coherent-labs.com/cpp-prysm/integration/optional_features/globalbackdropfilter/), по данным поиска). Линтер react-doctor советует держать размытие меньше 10 px или предблюрить статичный источник в картинку ([правило](https://www.react.doctor/prompts/rules/react-doctor/no-large-animated-blur.md), по данным поиска). В R4 уже решено «блюрить один раз при загрузке» (R4, таблица эффектов), модель данных хранит «заранее размытые версии» фонов (05 §ассеты).
- **Замер StackBlur** ([`stackblur-canvas`](https://www.npmjs.com/package/stackblur-canvas) 3.0.1, 2026-03-14, MIT), RGBA, один поток:

| Размер | Радиус | Время |
|---|---|---|
| 3840×2160 | 60 | 581 мс |
| 1920×1080 | 30 | 124 мс |
| **480×270** | **8** | **6,6 мс** |
| 240×135 | 4 | 1,8 мс |

  Сильно размытая картинка состоит из низких частот. Если её уменьшить в 8 раз и размыть на радиус в 8 раз меньше, а потом растянуть с линейной фильтрацией, глаз разницы с 4K-блюром не видит. Поэтому храним производную 480–960 px по длинной стороне в WebP или JPEG (десятки КБ) и рисуем одним спрайтом.
- **В Pixi v8** есть `BlurFilter`, `KawaseBlurFilter` и `BackdropBlurFilter` ([pixi-filters](https://github.com/pixijs/filters) 6.1.5 для Pixi v8, MIT). Они нужны только для эффектов «по требованию», например размытия холста под модальным окном. На каждый кадр их не включаем.

#### 5.2. Анимированные шейдерные фоны

| Вариант | Версия, лицензия | Плюсы | Минусы |
|---|---|---|---|
| [`@paper-design/shaders`](https://www.npmjs.com/package/@paper-design/shaders) | 0.0.81 (2026-09-17), Apache-2.0 + NOTICE «Powered by Paper Shaders» | Готовые `mesh-gradient`, `static-mesh-gradient`, `grain-gradient`, `dithering`, `image-dithering`, `halftone-dots`, `paper-texture`, `perlin-noise`, `god-rays`, `smoke-ring`, `warp` и другие (список файлов `dist/shaders`) | Версия 0.0.x. Каждый монтаж создаёт **свой** контекст `webgl2` (`shader-mount.js`), то есть второй GPU-контекст рядом с Pixi. Лучше портировать нужный GLSL в фильтр Pixi или запекать кадр в текстуру. NOTICE обязателен по Apache-2.0 §4(d) |
| [`@shadergradient/react`](https://www.npmjs.com/package/@shadergradient/react) | 2.4.20 (2025-12-08), MIT | Красивые 3D-градиенты | Тянет React Three Fiber, для фона тяжело |
| Свой фильтр Pixi (fBm-шум, 2–3 октавы) | — | Один проход в том же контексте, полный контроль | Писать самим (около 50 строк GLSL) |

💡 Анимированный фон ломает рендер «по требованию»: в покое холст R4 не перерисовывается. Если анимация включена, фон рендерится в отдельную текстуру в ¼ разрешения на 15–30 fps и композится. Пока окно не в фокусе, вкладка скрыта, включён `prefers-reduced-motion` или устройство на батарее с режимом экономии (❓), анимация замирает.

#### 5.3. Туман, зерно, дизеринг-постпроцесс, CRT

| Эффект | Дешёвая реализация | Цена | Замечания |
|---|---|---|---|
| **Туман** | 2–3 больших полупрозрачных спрайта шума с параллаксом 2–5 % от движения камеры; виньетка запечена в предблюренный фон | Почти ноль: несколько квадов | Полноэкранный fBm-шейдер каждый кадр не нужен |
| **Плёночное зерно** | Статичная тайловая текстура шума 256×256 с непрозрачностью 3–6 %, режим `overlay` или `multiply` | Один квад | Анимированное зерно (`NoiseFilter`, `OldFilmFilter` в pixi-filters) — только в пресете «Кино» на 12 fps |
| **Дизеринг-постпроцесс** (1-бит, «Обра Динн») | Bayer или blue noise в финальном проходе | Один полноэкранный проход | При движении камеры экранный узор «плывёт». Lucas Pope привязал узор к сфере вокруг камеры: стабилен при повороте, но не при перемещении ([пересказ девлога](https://www.Metafilter.com/170872/man-this-dithering-is-stable-as-shit-total-magic-going-on-here), по данным поиска). Surface-Stable Fractal Dithering (Rune Skovbo Johansen) держит точки на поверхностях ([runevision.com](https://runevision.com/tech/dither3d)); порты под MPL-2.0 ([Godot asset](https://godotengine.org/asset-library/asset/4555), 2025-12-10, по данным поиска). Для 2D-холста с зумом экранный дизеринг рябит — дизерим ассеты, а не кадр |
| **CRT-сканлайны** | CSS-оверлей `repeating-linear-gradient` поверх хрома или `CRTFilter` (pixi-filters) поверх 3D | Один композитный слой / один проход | Поверх текста снижают читаемость. Никакого мерцания: [WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html) — не больше 3 вспышек в секунду |
| **Свечение (glow)** для дедлайнов и ключевых | Заранее отрисованный спрайт ореола, тонируемый | Ноль проходов | `GlowFilter` или `AdvancedBloomFilter` на тысячу нод — дорого |

#### 5.4. Легальные источники пресетов фона

| Источник | Лицензия | Можно ли класть в open-source-поставку |
|---|---|---|
| **Процедурная генерация** (шум, градиенты, туман) | Наша | ✅ Лучший вариант: ноль юридических рисков, ноль байт в поставке |
| [Poly Haven](https://docs.polyhaven.com/en/faq) (HDRI, текстуры) | CC0. Нельзя выдавать себя за автора и перелицензировать; ссылку на сайт просят по возможности (по данным поиска) | ✅ Туманные и пасмурные HDRI → LDR-кроп → ч/б → блюр |
| [ambientCG](https://licenseorg.com/guide/3d-assets/ambientcg) | CC0 (по данным поиска) | ✅ Фактуры: бумага, бетон, туман |
| [The Met Open Access](https://www.metmuseum.org/hubs/open-access) | CC0 (по данным поиска) | ✅ Гравюры как фон-фактура |
| [NASA](https://www.nasa.gov/nasa-brand-center/images-and-media) | Как правило, не охраняется авторским правом в США; логотипы и третьи лица — исключение (по данным поиска) | ✅ С проверкой каждого снимка. Подходит для 3D-«космоса» |
| ESA | CC BY-SA 3.0 IGO, где это указано; для рекламы нужно согласование ([ESA](https://open.esa.int/?p=2), по данным поиска) | ⚠️ ShareAlike и атрибуция. Лучше не брать |
| [Unsplash](https://unsplash.com/license) | Своя лицензия, не CC0. Запрещено «compile photos from Unsplash to replicate a similar or competing service» ([help](https://help.unsplash.com/en/articles/2612331-why-can-t-i-compile-photos-from-unsplash-to-replicate-a-similar-or-competing-service)); ограничения на ML/AI (по данным поиска) | ❌ Для поставки — нет: набор фото в открытом репозитории легко извлечь. Пользователь может загрузить фото сам |
| [Pexels](https://help.pexels.com/hc/en-us/articles/360042332714-What-are-the-rules-for-using-Pexels-photos-or-videos) | Своя лицензия: нельзя продавать неизменённые копии, нельзя распространять на «wallpaper»-платформах (по данным поиска) | ❌ Аналогично |

### 6. «Мор»: что делает майндмэп Pathologic 2 читаемым

Источники: статья нарративного дизайнера Ice-Pick Lodge Alphyna по докладу 2019 года ([Game World Observer, 2019-08-12](https://gameworldobserver.com/2019/08/12/pathologic-2-narrative-design), перепечатка на [Game Developer](https://www.gamedeveloper.com/design/pathologic-2-mindmap-a-questlog-people-actually-read)), гайды Steam и ответ владельца ✅ I1. Сами страницы недоступны, цитаты — по данным поиска.

| Наблюдение | Источник | Перевод в правило Strata |
|---|---|---|
| «The mindmap is made up of circles that we call nodes. Each of them symbolizes a thought.» Все мысли в одинаковых кругах | Alphyna; критик отмечает однородность ([Medium](https://medium.com/@Urzashottub/pathologic-and-the-burden-of-perfection-c662e59f2444)) | Бабл всегда круг (💡 D6). Вид ноды кодируем кромкой и значком, а не формой. Форма — пользовательская опция (требование «цвет/форма ноды») |
| Квесты — красные, у некоторых «red glare» — они же метки на карте | Alphyna; [гайд Steam](https://steamcommunity.com/sharedfiles/filedetails/?id=1787270555) | Красный редок и значит «требует действия»: у нас это только просрочка |
| Упущенные возможности — **жёлтые**: «we didn't want the player to feel like we were scolding them» | Alphyna | Жёлтый — единственный «тёплый» акцент: «скоро», «внимание». Не ошибка |
| Пунктирные узлы намекают на будущие последствия, их число не раскрывается | Alphyna (по данным поиска) | Призраки `[[X]]` — пунктирные приглушённые баблы (05 уже так решила) |
| Чтобы не загромождать экран, один и тот же круг обновляли несколько раз вместо цепочки | Alphyna | Свёртки (roll-up): прогресс и дедлайн внутри сети показываются на её бабле (05 §6.4), а не новыми нодами |
| Карта — «голос героя», его мысли | Alphyna | Подписи короткие, «человеческие». Технические детали — в инфокарточке |
| Скрин владельца: туманная ч/б фотография, белые круглые баблы с детальными гравюрными иконками, тонкие белые нити, ключевые крупнее, второстепенные приглушены и полупрозрачны, редкий слабый жёлтый | ✅ I1 | Иерархия размером (флаг «Ключевая»), неактивное — прозрачностью, линии 1–1,5 px, монохром + один акцент |

Почему это читается:

1. **Три независимых канала** — размер, яркость или прозрачность и цвет акцента. Они не спорят друг с другом, и цвет почти не используется.
2. **Одинаковая толщина линии в иконках.** Гравюрная прорисовка сделана одним «пером», поэтому иконки разных объектов выглядят одним семейством.
3. **Фон не конкурирует.** Он размыт, обесцвечен и темнее любого бабла, поэтому белый круг всегда самый контрастный объект.
4. **Минимум текста на холсте.** Подпись появляется по требованию.

### 7. Доступность: требования WCAG 2.2, которые задевают этот стиль

| Критерий | Уровень | Требование (из текста критерия) | Где нас задевает |
|---|---|---|---|
| [1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | AA | Текст ≥ 4.5:1, крупный ≥ 3:1. Неактивные компоненты исключены | Пиксельный текст 11 px — «обычный», значит 4.5:1. Подписи поверх фото-фона |
| [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | AA | Компоненты UI и графика, нужная для понимания, ≥ 3:1 к соседним цветам | Баблы, нити, кольца состояний на пользовательском фоне |
| [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) | A | Цвет не единственный способ передать информацию | Просрочка и «скоро» — не только красный и жёлтый |
| [2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) | A | Движение или мигание, которое стартует само, длится > 5 с и идёт параллельно с другим контентом, должно останавливаться | «Пульсация» дедлайна «сегодня» (05 §6.3), анимированный фон, колыхание нитей |
| [2.3.1 Three Flashes](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html) | A | Не больше 3 вспышек в секунду | CRT-мерцание, «глитч» |
| [2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) | AAA | Анимацию от взаимодействия можно отключить | Полёты камеры, «шейк» для отвязки, пружинящие нити |
| [2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | AA | Цель ≥ 24×24 CSS px или достаточный зазор | Мелкие баблы на отдалении, контролы ретро-окон |

Медиазапросы (MDN, данные BCD): `prefers-reduced-motion` — Chrome 74, Firefox 63, Safari 10.1; `prefers-contrast` — Chrome 96, Firefox 101, Safari 14.1; `forced-colors` — Chrome 89, Firefox 89, Safari 16; `prefers-reduced-transparency` — экспериментальный, Chrome 118, в Safari нет ([BCD media.json](https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json)).

**Расчёт контраста для холста.** Бабл `#F2EFE6` имеет относительную яркость L = 0,863. Альфа смешивается в sRGB, как это делают браузеры и Pixi по умолчанию. Скрипт этого исследования дал:

| Яркость фона L (серый sRGB) | Бабл 100 % | Нить 80 % | Нить 60 % | Приглушённое 40 % |
|---|---|---|---|---|
| 0,05 (≈ `#3F3F3F`) | 9,1:1 | 6,5:1 | 4,5:1 | 2,9:1 |
| **0,10 (≈ `#595959`)** | **6,1:1** | **4,6:1** | **3,3:1** | 2,3:1 |
| 0,15 (≈ `#6C6C6C`) | 4,6:1 | 3,6:1 | 2,7:1 | 2,0:1 |
| 0,18 (≈ `#767676`) | 4,0:1 | 3,2:1 | 2,5:1 | 1,9:1 |

Вывод. При L фона ≤ 0,10 нити с альфой 60 % проходят 3:1. Приглушённые «готовые» ноды не проходят, но это допустимо: неактивные компоненты из 1.4.11 исключены. Статус «готово» дублируется значком.

## Сравнение вариантов

### Шрифты: роли

| Роль | Кандидаты с кириллицей | Выбор | Почему |
|---|---|---|---|
| Дисплей: заголовки окон, крупные надписи, «экран ошибки» | Press Start 2P, Tiny5 (крупно), Handjet, Rubik Pixels, Pixelify Sans (после фикса) | **Press Start 2P** 8/16/24 px | Самый узнаваемый «8-бит», полная кириллица, строгая сетка 8 px. Широкий, поэтому только для коротких строк |
| UI: меню, Tab-меню, строка пути, статус-бар, подписи в экранном пространстве | Departure Mono, Tiny5, Spleen 8×16, Monocraft, Pixel Code, Fixedsys Excelsior, PxPlus | **Departure Mono** 11/22 px; пропорциональная альтернатива — **Tiny5** 16 px | Departure Mono: 216 знаков кириллицы, «№», «ёлочки», сетка 11 px — компактнее 16-пиксельных. Под OFL, поддерживается. Tiny5 даёт пропорциональный набор и ось `wdth` для узких мест |
| Текст заметок (проза) | Golos Text, Onest, Inter, PT Sans | **Golos Text** | 172 знака кириллицы, украинские и белорусские буквы, OFL, вариативный вес. Inter — запасной |
| Моноширинный текст и код | JetBrains Mono, IBM Plex Mono, Geist Mono, Fira Code | **JetBrains Mono** | OFL без RFN, широкое покрытие. Тот же шрифт в CodeMirror (R4) |
| Пиксельный фолбэк для экзотических символов | Unifont, Fusion/Ark Pixel | **Unifont** (OFL-ветка двойной лицензии) | Покрывает BMP. Ark Pixel сам советует его для 16 px |

### Иконки: стратегия

| Вариант | Стиль «Мор» | Объём | Юридические затраты | Вывод |
|---|---|---|---|---|
| Только game-icons | Хорошо (детальные силуэты) | 4133 | Поавторская атрибуция CC BY 3.0 | ✅ Основной пресет-набор |
| Свои гравюры из PD/CC0 через конвейер | Отлично (настоящая гравюра) | 100–200 (курируем) | Проверка статуса каждого исходника | ✅ Фирменный пресет «Гравюры», этап 2 |
| Pixelarticons | Ретро-хром, не баблы | 1036 | MIT, только сохранить копирайт | ✅ Иконки интерфейса |
| HackerNoon / Streamline Pixel | Ретро | 578 / 662 | CC BY 4.0 | ⚠️ Не нужны при наличии Pixelarticons |
| Kenney 1-Bit | Игровой пиксель | 1000+ | CC0 | ✅ Пасхалки, курсоры |
| Phosphor / Tabler / Lucide | Нет | 1877–9072 | MIT/ISC | ✅ Только «читаемый режим» |
| Встроенный пиксельный редактор иконок | — | — | — | ❌ Не в MVP (I6): конвейер стилизации закрывает 90 % потребности |

### Фоны: подходы

| Подход | Цена кадра | Вид | Риски | Вывод |
|---|---|---|---|---|
| Предблюренная загрузка + нормализация яркости | ≈ 0 | «Мор» | Нужна нормализация, иначе пропадает контраст | ✅ По умолчанию |
| Процедурный статичный (fBm, градиент), запечённый в текстуру | ≈ 0 | Абстракция | — | ✅ Пресеты |
| Процедурный анимированный (фильтр Pixi, ¼ разрешения, 15–30 fps) | 0,3–1 мс (оценка, не замерено) | «Живой туман» | Батарея; ломает рендер «по требованию» | 💡 Опция, по умолчанию выключено |
| `backdrop-filter` / живой `BlurFilter` | Высокая, каждый кадр | То же | WebKitGTK и слабые GPU (R4) | ❌ |
| Фото-стоки (Unsplash, Pexels) в поставке | — | — | Лицензии не CC0 | ❌ |

### Ретро-хром: своё или кит

| Вариант | Плюсы | Минусы | Вывод |
|---|---|---|---|
| 98.css как зависимость | Готово, MIT | Шрифт без кириллицы под CC BY-SA; узнаваемый Windows; мелкие контролы | ❌ |
| React95 | Компоненты на React | Иконки Microsoft, тема Win95 | ❌ |
| Своя библиотека окон на токенах (техники из 98.css, system.css, мудборда) | Свой стиль, темы BSOD, ч/б и розовая, доступные размеры | 300–500 строк CSS и десяток компонентов | ✅ |

## Рекомендация для Strata

### 1. Шрифты

| Слот (CSS-переменная) | Шрифт | Кегли (физические пиксели, кратно сетке) | Где |
|---|---|---|---|
| `--font-display` | Press Start 2P 3.000 (OFL, RFN) | 16, 24, 32 | Заголовки окон, «экраны ошибок», пустые состояния, крупные цифры. Строки ≤ 30 символов |
| `--font-ui` | Departure Mono 1.500 (OFL) | 11 (плотный), **22** (по умолчанию на HiDPI) | Меню, Tab-меню, строка пути, статус-бар, подписи баблов в экранном пространстве, бейджи |
| `--font-ui-prop` | Tiny5 2.007 (OFL) | 16, 24 | Там, где моноширинный не влезает: длинные подписи в узких панелях |
| `--font-text` | Golos Text 2.004 (OFL) | 15–18 CSS px, плавно | Тело заметок, инфокарточки, длинные описания |
| `--font-mono` | JetBrains Mono 2.211 (OFL) | 13–16 CSS px | Код, моноширинный режим заметок |
| `--font-fallback-pixel` | Unifont (OFL-ветка) | 16 | Символы, которых нет в Departure Mono |

Правила:

1. 💡 **Пиксельный текст — только в экранном пространстве** и только в кеглях `k × сетка`. Кегль считается от физических пикселей через `--u` (раздел 2). Подписи баблов — экранные оверлеи, привязанные к позиции бабла с округлением до физического пикселя. Размер меняется ступенями (11 → 22) по уровню зума, а не плавно. В мировом пространстве и в «читаемом режиме» — MSDF-версия Golos Text (R4 §2.7).
2. **Pixelify Sans не используем**, пока в нём нет О, П, І. Если владельцу нравится именно он, это форк с дорисовкой трёх глифов (OFL без RFN разрешает) под своим именем.
3. **Никаких шрифтовых CDN.** Шрифты лежат в сборке (Fontsource для пяти шрифтов, Departure Mono — из репозитория автора). Тексты OFL — в «Благодарностях».
4. В Excalidraw-доске (R5) — Golos Text или Nunito. Пиксельный шрифт на холсте доски — только через форк (R5 §6).

### 2. Ретро-окна (UI-хром)

- 💡 Свои компоненты: окно, заголовок, кнопка, поле, меню, вкладки, статус-бар, диалог «ошибки», прогресс. На токенах:
  - `--chrome-bg`, `--chrome-fg`, `--chrome-title-bg`, `--chrome-title-fg`, `--chrome-hi`, `--chrome-shadow`, `--chrome-frame`, `--accent`;
  - темы: «Туман» (по умолчанию: ч/б, акцент жёлтый), «BSOD» (`#0000AA` / белый), «Терминал» (чёрный / белый или янтарь), «Dinolab» (светло-серая сетка / розовый). ❓ I3.
- Фаски — двухслойные `inset`-тени в единицах `u` (техника 98.css). Пунктирные разделители и инверсные плашки-заголовки взяты из мудборда. 1-битные узоры 2×2 и 4×4 (тень окна, неактивный заголовок) — маленькие PNG с `image-rendering: pixelated`.
- Доступные размеры по умолчанию: контрол ≥ 24×24 CSS px, фокус — 2 px сплошная рамка плюс пунктир, контраст текста ≥ 4.5:1 (для пиксельного UI-текста 💡 цель 7:1).
- Не копируем Windows 95/98 буквально: ни иконок, ни шрифта, ни кнопки «Пуск». Хром «по мотивам», иначе это риск trade dress.

### 3. Иконки

1. **Значки состояний и видов** (около 40 штук: вид ноды, статус, флаги, ярлык появления, «↗ внешние связи», замок, «скрыто от AI», песочные часы, «!»): 💡 **рисуем сами** на сетке 8×8 и 16×16, кладём в репозиторий под лицензией проекта. Работа на 1–2 дня. Это фирменный слой, и он гарантированно чёткий на 1×/2×.
2. **Иконки интерфейса** (тулбары, меню): Pixelarticons (MIT, 1036, сетка 24, кегли 24/48). В «читаемом режиме» — Phosphor.
3. **Иконки нод (пресеты):**
   - **MVP:** game-icons (CC BY 3.0) через `@iconify-json/game-icons`, плюс сборочный скрипт, который по папкам репозитория строит `credits.json` (иконка → автор). Пикер показывает автора, экран «Благодарности» — список всех авторов и ссылку на лицензию;
   - **этап 2:** фирменный набор «Гравюры» (100–200 мотивов из Met Open Access и других PD-источников через конвейер).
4. **Свои иконки** — 💡 конвейер «привести к стилю» в воркере:
   1. Приём PNG, JPEG, WebP, AVIF, SVG (через DOMPurify), GIF (`ImageDecoder` или gifuct-js), эмодзи.
   2. Удаление фона: альфа, заливка от углов, ластик.
   3. Режимы: «Как есть» (обрезка в круг), **«Гравюра»** (по умолчанию: ч/б → уровни → Otsu → лёгкий unsharp), «Пиксель» (уменьшение до 24 или 32 → Bayer или Atkinson → увеличение ближайшим соседом), «Силуэт» (альфа → сплошная заливка), «Фото» (Floyd–Steinberg, для медиа-нод).
   4. Предпросмотр сразу в бабле в трёх состояниях (обычное, выделенное, приглушённое), ползунок порога, «инвертировать».
   5. Результат — 1-битная или 2-битная маска 32/64/128 px, сохраняется как производный ассет по хешу. Оригинал и параметры храним, производные пересобираются.
   6. Анимация GIF: только при наведении или выделении, ≤ 64 кадров, выключена при `prefers-reduced-motion`.
   7. Предложение к [05](../05-domain-model.md) (поле `icon`): к «пресет / ассет / эмодзи + цвет подкраски» добавить параметры стилизации `{ mode, threshold, dither, invert }`. Это расширение, а не противоречие. Решение — за владельцами 05/07.
5. **Атлас иконок** для Pixi: маски в одном атласе с мип-уровнями, тонирование шейдером по состоянию. Детальная гравюра на кружке меньше 32 px рябит, поэтому нужен LOD (п. 4).

### 4. Правила состояний бабла (для [07](../07-design-system.md))

Базовая грамматика (💡, по «Мору»):
- **круг** — всегда;
- **белая заливка `#F2EFE6`, чёрная иконка** — по умолчанию;
- **нити** — 1,5 px белые, альфа 60 %; у выделенного пути 100 %;
- **акценты** — жёлтый `#E8C547` («внимание») и красный `#D64545` («просрочено»);
- **цвет пользователя** (аналог цвета ноды Houdini) — только кольцо 3 px по кромке, не заливка. Так монохром холста сохраняется.

| Состояние | Заливка, иконка | Кромка | Прозрачность | Значок (форма, не цвет) | Движение |
|---|---|---|---|---|---|
| Обычное | Белая, чёрная иконка | 1 px тёмная внутренняя | 100 % | — | — |
| Наведение | Как обычное | + внешнее кольцо 1 `u` с зазором 2 `u` | 100 % | Подпись появляется сразу | Масштаб 1,05 за 80 мс; при reduced motion — без масштаба |
| Выделенное | Как обычное | Кольцо 2 `u` + четыре пиксельных «уголка» `⌜⌝⌞⌟` | 100 % | — | — |
| Текущее (последнее выделенное, как current node в Houdini) | Как выделенное | Уголки + «марширующие муравьи» по кругу | 100 % | — | Муравьи статичны при reduced motion |
| Фокус клавиатуры | — | Пунктир 2 `u` снаружи (не путать с выделением) | — | — | — |
| Ключевая (флаг) | Как обычное | Двойная кромка | 100 % | — | Диаметр на ступень больше: S → M → L → XL (05 §раскладка) |
| Сеть (вид) | Как обычное | Двойное кольцо «стопкой» + дуга прогресса свёртки по кромке | 100 % | Мини-значок вида внизу | — |
| Заметка / доска / список / медиа (вид) | Медиа: ч/б миниатюра в круге (Floyd–Steinberg) | Одинарная | 100 % | Мини-значок вида 8×8 у кромки внизу | — |
| Появление (instance) | Как обычное | Как обычное | 100 % | Стрелка-ярлык 8×8 слева внизу; «×N» при наведении (05) | — |
| Призрак `[[X]]` | Без заливки, иконка «?» | Пунктир | 50 % | «?» | — |
| Готово / отменено (финальный статус) | Серая `#9A9A9A`, иконка тёмно-серая | Без кольца | **40 %** | Галочка 8×8 | — |
| Пауза (флаг) | Белая, поверх 1-битная штриховка 50 % | Пунктир | 60 % | Значок паузы | — |
| Дедлайн скоро (≤ N дней, по умолчанию 3) | Как обычное | — | 100 % | Песочные часы 8×8 | Статичный жёлтый ореол (спрайт) |
| Дедлайн сегодня | Как обычное | Жёлтое кольцо 2 `u` | 100 % | Песочные часы | **3 пульса за 2–3 с при появлении в кадре, затем статично** (WCAG 2.2.2). При reduced motion — без пульса |
| Просрочено (статус не финальный) | Как обычное | Красное кольцо 2 `u` | 100 % | «!» 8×8 | Без анимации |
| Свёртка «внутри горит» (у сети) | Как обычное | Дуга кромки жёлтая или красная, тоньше собственного кольца | 100 % | Маленький «!» или часы с точкой | — |
| Замок | — | — | — | Замок 8×8 | — |
| Скрыто от AI | — | — | — | Перечёркнутый глаз — только в AI-линзе | — |
| Участники (на сервере) | — | — | — | Цветные точки-аватары на кромке (05) | — |

**Семантический зум** (💡 D6), по экранному диаметру бабла:

| Диаметр | Что рисуем |
|---|---|
| < 12 px | Точка 2–4 px в цвете состояния (белая, серая, жёлтая, красная) |
| 12–32 px | Круг + пиксельный значок вида 8×8 или 16×16 вместо детальной иконки |
| 32–96 px | Круг + детальная иконка + подпись под баблом (Departure Mono 11 или 22) |
| > 96 px | + строка превью: статус, дедлайн, счётчики |

Зона попадания курсора — не меньше 24×24 CSS px, даже если сам бабл меньше (WCAG 2.5.8).

### 5. Фоны

- 💡 **Конвейер загрузки фона** (воркер):
  1. `createImageBitmap`;
  2. уменьшение до 960 px по длинной стороне;
  3. StackBlur (радиус задаёт пользователь, 4–16);
  4. опционально обесцвечивание (по умолчанию 80 %);
  5. **нормализация яркости**: тон-кривая, чтобы 95-й перцентиль L был ≤ 0,10 в тёмной теме;
  6. запечённая виньетка;
  7. WebP ≈ 80 %.

  Оригинал и параметры храним (05 §ассеты). Стоимость — единицы миллисекунд.
- **Рендер:** один спрайт «cover», параллакс 2–5 % от камеры, без блюра в кадре. Поверх — статичное зерно 3–6 % и 2–3 спрайта тумана.
- **Пресеты в поставке (MVP):**
  - 4 процедурных, генерируются при первом запуске и кешируются: «Туман» (fBm, серый), «Глубина» (радиальный градиент), «Сумерки» (обесцвеченный mesh-градиент), «Пыль» (шум + редкие точки);
  - 2–4 фото из CC0: туманный пейзаж из HDRI Poly Haven, гравюра Met как фактура.

  Unsplash и Pexels не кладём.
- **Где задаётся фон:** у пространства по умолчанию плюс переопределение на сеть. При нырке в сеть фон меняется кроссфейдом 300 мс, при reduced motion — мгновенно. ❓ I7.
- **Анимированный фон** — опция, выключен по умолчанию. Рендер в ¼ разрешения, 15–30 fps, замирает вне фокуса или при reduced motion.

### 6. Бюджет эффектов

Цель R4: p95 ≤ 16,7 мс при 5000 нод на встроенной графике. 💡 Распределение (оценка, проверить в спайке):

| Слой | Бюджет | По умолчанию | Reduced motion | «Экономия» / слабый GPU (WebKitGTK, R4) |
|---|---|---|---|---|
| Фон (спрайт + туман + зерно) | ≤ 0,5 мс | Вкл. | Туман без дрейфа | Только спрайт |
| Баблы и иконки (инстансы, атлас) | ≤ 6 мс | — | — | Без мип-LOD-переходов |
| Нити (инстансный шейдер, R4) | ≤ 4 мс | Безье | Без колыхания | Прямые |
| Ореолы и кольца состояний | ≤ 1 мс | Спрайты | Без пульса | Спрайты |
| Пост: дизеринг, CRT | ≤ 1,5 мс в ½ разрешения | **Выкл.** | Выкл. | Выкл. |
| Анимированный фон | ≤ 1 мс (¼ разрешения, 15–30 fps) | Выкл. | Выкл. | Выкл. |
| Запас | ≈ 4 мс | | | |

В покое — 0 кадров: рендер только по событию. Любой эффект, которому нужен непрерывный кадр, отключается в фоне вкладки, при `document.hidden` и в режиме экономии.

3D (H7, ❓): по умолчанию «красивый» туманный космос со спрайтами-ореолами. 1-битный Bayer-постпроцесс — опция «Обра Динн» с оговоркой про стабильность узора при движении (5.3).

### 7. Доступность и «читаемый режим»

- 💡 **«Читаемый режим»** (переключатель в настройках). Предлагается автоматически при `prefers-contrast: more` и `forced-colors: active`:
  - все пиксельные шрифты заменяются на Golos Text и JetBrains Mono;
  - иконки интерфейса — Phosphor;
  - эффекты (зерно, CRT, дизеринг, туман) выключены;
  - фон — сплошной `#111` или пользовательский с L ≤ 0,05;
  - нити 100 %, кегль UI ≥ 14 CSS px.
- **`prefers-reduced-motion`:**
  - нет пульса, колыхания нитей (кинетика Kinopio), «марширующих муравьёв», анимированных GIF и фона;
  - перелёты камеры к ноде и нырки заменяются мгновенным переходом или фейдом ≤ 150 мс;
  - WASD-полёт в 3D остаётся: это движение, которым управляет сам пользователь.
- **`prefers-reduced-transparency`** (только Chromium): приглушённые состояния передаются штриховкой и серым вместо альфы.
- **Без вспышек:** никаких мерцающих CRT и «глитчей» (WCAG 2.3.1).
- **Цвет никогда не единственный канал:** у «скоро», «сегодня», «просрочено», «готово» и «пауза» есть свой значок-форма (таблица п. 4).
- **Контраст на пользовательском фоне** гарантирует нормализация яркости (п. 5). Подписи на холсте всегда на плашке `rgba(0,0,0,.7)`, а не прямо по фото.
- **Холст недоступен скринридеру.** Параллельно нужен DOM-вид «список / дерево» текущей сети (вид-линза «список» из глоссария) с той же навигацией с клавиатуры. Подробности — в 06 и 14.

### 8. Что проверить в спайке дизайна (до 07)

1. Макет холста: 200 баблов game-icons на трёх фонах (процедурный туман, HDRI Poly Haven, загруженное фото с нормализацией). Проверить читаемость и контраст по таблице раздела 7.
2. Ретро-окно на токенах: Departure Mono 11 и 22, Press Start 2P 16 на DPR 1, 1,25, 1,5, 2 в Chrome, Firefox, Safari и Tauri WebKitGTK.
3. Конвейер стилизации: 20 разнородных картинок (фото, логотип, скан гравюры, скриншот). Насколько часто режим «Гравюра» даёт приемлемый результат без ручной правки.
4. Замер кадра Pixi с ореолами-спрайтами, статичным зерном и туманом на 5000 нод (вместе с R4 п. 1).

## Риски

- **Мыло пиксельных шрифтов при дробном DPR и зуме.** Без дисциплины «пиксельной единицы» UI выглядит дёшево. Гарантии чёткости на Windows и Linux нет: сглаживание там не отключить.
- **Pixelify Sans и другие «с заявленной кириллицей».** Метаданные Google Fonts не гарантируют полноты (Pixelify: нет О и П). Каждый новый шрифт или пользовательский шрифт надо проверять по `cmap`. Нужен автотест: строка «ПРОЕКТ ёжик №» проверяется в CI.
- **Атрибуция CC BY.** game-icons — 36 авторских папок. Если потерять соответствие «иконка → автор», лицензия нарушается. HackerNoon — ловушка (npm пишет MIT, иконки под CC BY 4.0).
- **Чужие шрифты и торговые марки в ретро-китах.** 98.css (CC BY-SA, «MS Sans Serif»), system.css (`monaco.woff` без лицензии), иконки Windows в React95. Брать техники, а не файлы.
- **ShareAlike и копилефт.** PxPlus (CC BY-SA 4.0), Unifont в GPL-ветке, unscii-full (GPL), potrace (GPL-2.0), `@imgly/background-removal` (AGPL-3.0). Лицензия Strata не выбрана, поэтому всё такое пока не тянем.
- **Пользовательский фон ломает контраст** (яркое фото), а пользовательская иконка — стиль («кислотный» PNG). Без нормализации и стилизации холст быстро превращается в «хаос», против которого предостерегает видение (03 п. 6).
- **XSS через SVG** на общем сервере. Санитизация и рендер только растра обязательны.
- **WebKit без `ImageDecoder`.** Анимированные GIF на macOS и Linux (Tauri) декодируются JS-фолбэком: дороже по памяти и CPU.
- **Дизеринг и зум.** Экранный дизеринг поверх масштабируемого холста рябит и «плывёт». Дизерить нужно ассеты на этапе загрузки, экранный пост — только в 3D и опционально.
- **Анимации и батарея.** Анимированный фон, зерно и пульс держат GPU в постоянной работе. На WebKitGTK со «скрытым медленным путём» (R4) это заметно.
- **Эстетика против читаемости.** Пиксельный UI на 8-часовом рабочем дне утомляет. Без «читаемого режима» часть команды откажется от продукта.
- **Pathologic — чужое произведение.** Берём принципы (размер, прозрачность, пунктир, один акцент), а не скриншоты, иконки и шрифты игры.

## Открытые вопросы

- **Q-R7-1.** Язык интерфейса: только русский или русский и английский (сейчас «неизвестно»)? Кириллица обязательна в любом случае. Нужны ли украинские и белорусские буквы (все рекомендованные шрифты их имеют)?
- **Q-R7-2.** Согласны ли с правилом «пиксельный шрифт только в окнах и экранных подписях, текст заметок — Golos Text», или хочется «пиксель везде» хотя бы как опцию темы (I4)?
- **Q-R7-3.** Допустима ли атрибуция CC BY (экран «Благодарности» и автор в пикере) для набора game-icons, или в поставке нужны только CC0 и MIT?
- **Q-R7-4.** Кто готовит фирменные ассеты: около 40 пиксельных значков состояний и вида и набор «Гравюры» из PD-источников (I8)? Есть ли дизайнер, или это делает разработчик по готовым правилам?
- **Q-R7-5.** Нужен ли встроенный пиксельный редактор иконок (I6), или достаточно конвейера «привести к стилю» с режимами «Гравюра», «Пиксель», «Силуэт», «Фото»?
- **Q-R7-6.** Фон: один на пространство или переопределяемый на каждой сети (I7)? Нужен ли анимированный фон хотя бы как опция?
- **Q-R7-7.** Эффекты (I5): CRT, зерно, ретро-звуки, пиксельные курсоры, ироничные тексты. Что включено по умолчанию, что опция, что не делаем?
- **Q-R7-8.** Темы (I3): какие пресеты в MVP — «Туман», «BSOD», «Терминал», «Dinolab»? Нужна ли светлая тема холста (тогда грамматика инвертируется: чёрные баблы на светлом тумане)?
- **Q-R7-9.** Палитра акцентов: жёлтый для «внимание» и красный только для «просрочено» — подтверждаете? Как в Houdini подсвечивать выделение (у Houdini жёлтый): цветом или уголками и формой, как предложено?
- **Q-R7-10.** Стиль 3D (H7): туманный космос со свечением по умолчанию и 1-битный дизеринг как опция — так?
- **Q-R7-11.** Лицензия Strata (B): от неё зависит, можно ли брать GPL-компоненты (potrace, Unifont в GPL-ветке) и CC BY-SA-шрифты (PxPlus).

## Источники

**Шрифты (лицензии и файлы)**
- https://github.com/google/fonts/tree/main/ofl/pressstart2p
- https://github.com/google/fonts/blob/main/ofl/pressstart2p/OFL.txt
- https://github.com/google/fonts/tree/main/ofl/pixelifysans
- https://github.com/eifetx/Pixelify-Sans
- https://github.com/google/fonts/tree/main/ofl/tiny5
- https://github.com/Gissio/font_tiny5
- https://github.com/google/fonts/tree/main/ofl/handjet
- https://github.com/rosettatype/Handjet/
- https://github.com/google/fonts/tree/main/ofl/rubikpixels
- https://github.com/google/fonts/tree/main/ofl/dotgothic16
- https://github.com/google/fonts/tree/main/ofl/silkscreen
- https://github.com/google/fonts/tree/main/ofl/jersey10
- https://github.com/google/fonts/tree/main/ofl/micro5
- https://github.com/google/fonts/tree/main/ofl/vt323
- https://github.com/google/fonts/tree/main/ofl/doto
- https://github.com/google/fonts/tree/main/ofl/bytesized
- https://github.com/google/fonts/tree/main/ofl/sixtyfour
- https://github.com/google/fonts/tree/main/ofl/workbench
- https://github.com/google/fonts/tree/main/ofl/bitcount
- https://github.com/google/fonts/tree/main/ofl/golostext
- https://github.com/google/fonts/tree/main/ofl/onest
- https://github.com/google/fonts/tree/main/ofl/inter
- https://github.com/google/fonts/tree/main/ofl/jetbrainsmono
- https://github.com/google/fonts/tree/main/ofl/ibmplexmono
- https://github.com/google/fonts/tree/main/ofl/ptsans
- https://github.com/rektdeckard/departure-mono
- https://github.com/rektdeckard/departure-mono/blob/main/public/assets/LICENSE
- https://github.com/IdreesInc/Monocraft
- https://github.com/qwerasd205/PixelCode
- https://github.com/the-moonwitch/Cozette
- https://github.com/fcambus/spleen
- https://github.com/fcambus/spleen/blob/master/ChangeLog
- https://github.com/kika/fixedsys
- https://github.com/viznut/unscii
- https://github.com/TakWolf/ark-pixel-font
- https://github.com/TakWolf/ark-pixel-font/blob/master/docs/info-12px-proportional.md
- https://github.com/TakWolf/fusion-pixel-font
- https://en.wikipedia.org/wiki/GNU_Unifont
- https://unifoundry.com/unifont/
- https://terminus-font.sourceforge.net/
- https://metadata.ftp-master.debian.org/changelogs//main/x/xfonts-terminus/xfonts-terminus_4.48-3_copyright
- https://int10h.org/oldschool-pc-fonts/readme/
- https://packagehub.suse.com/packages/int10h-oldschoolpc-fonts
- https://www.freshports.org/x11-fonts/oldschool-pc-fonts
- https://vercel.com/blog/introducing-geist-pixel
- https://www.npmjs.com/package/geist
- https://www.npmjs.com/package/@fontsource/press-start-2p
- https://www.npmjs.com/package/@fontsource/golos-text

**Рендер шрифтов и CSS**
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-smooth
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency
- https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json
- https://github.com/mdn/browser-compat-data/blob/main/api/ImageDecoder.json
- https://www.kirupa.com/hodgepodge/preserving_pixel_art_aesthetics.htm
- https://code.querie.cc/mirrors/code-piaforge-com/observe-ui/plain/notes/README_PIXEL_FONTS.md

**Ретро-UI**
- https://github.com/jdan/98.css
- https://github.com/jdan/98.css/blob/main/fonts/src/ms-sans-serif/license.txt
- https://github.com/botoxparty/XP.css
- https://github.com/khang-nd/7.css
- https://github.com/sakofchit/system.css
- https://github.com/nostalgic-css/NES.css
- https://github.com/React95/React95
- https://github.com/arturbien/React95
- https://github.com/webtui/webtui
- https://github.com/kristopolous/BOOTSTRA.386

**Иконки**
- https://github.com/game-icons/icons/blob/master/license.txt
- https://game-icons.net/about.html
- https://icon-sets.iconify.design/game-icons/bandit
- https://www.npmjs.com/package/@iconify-json/game-icons
- https://github.com/halfmage/pixelarticons
- https://github.com/hackernoon/pixel-icon-library
- https://pixeliconlibrary.com/license/
- https://opengameart.org/content/1-bit-pack
- https://github.com/phosphor-icons/core
- https://github.com/tabler/tabler-icons
- https://github.com/lucide-icons/lucide
- https://github.com/iconoir-icons/iconoir
- https://www.metmuseum.org/hubs/open-access
- https://huggingface.co/datasets/gigant/oldbookillustrations/commit/e3d786d9d384232e7961c6303a9b5dba95ed8758
- https://content.wellcomecollection.org/works/bpv75u4v

**Обработка изображений и дизеринг**
- https://surma.dev/things/ditherpunk/
- https://en.wikipedia.org/wiki/Atkinson_dithering
- https://github.com/thi-ng/umbrella/tree/develop/packages/pixel-dither
- https://github.com/ibezkrovnyi/image-quantization
- https://www.npmjs.com/package/imagetracerjs
- https://www.npmjs.com/package/potrace
- https://www.npmjs.com/package/esm-potrace-wasm
- https://www.npmjs.com/package/@imgly/background-removal
- https://www.npmjs.com/package/dompurify
- https://www.npmjs.com/package/gifuct-js
- https://runevision.com/tech/dither3d
- https://godotengine.org/asset-library/asset/4555
- https://www.Metafilter.com/170872/man-this-dithering-is-stable-as-shit-total-magic-going-on-here

**Фоны и эффекты**
- https://www.npmjs.com/package/stackblur-canvas
- https://github.com/pixijs/filters
- https://www.npmjs.com/package/@paper-design/shaders
- https://www.npmjs.com/package/@shadergradient/react
- https://www.npmjs.com/package/postprocessing
- https://docs.coherent-labs.com/cpp-prysm/integration/optional_features/globalbackdropfilter/
- https://www.react.doctor/prompts/rules/react-doctor/no-large-animated-blur.md
- https://docs.polyhaven.com/en/faq
- https://licenseorg.com/guide/3d-assets/ambientcg
- https://unsplash.com/license
- https://help.unsplash.com/en/articles/2612331-why-can-t-i-compile-photos-from-unsplash-to-replicate-a-similar-or-competing-service
- https://help.pexels.com/hc/en-us/articles/360042332714-What-are-the-rules-for-using-Pexels-photos-or-videos
- https://www.nasa.gov/nasa-brand-center/images-and-media
- https://open.esa.int/?p=2

**Pathologic 2**
- https://gameworldobserver.com/2019/08/12/pathologic-2-narrative-design
- https://www.gamedeveloper.com/design/pathologic-2-mindmap-a-questlog-people-actually-read
- https://steamcommunity.com/sharedfiles/filedetails/?id=1787270555
- https://medium.com/@Urzashottub/pathologic-and-the-burden-of-perfection-c662e59f2444

**Доступность (WCAG 2.2; тексты прочитаны в https://github.com/w3c/wcag)**
- https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
