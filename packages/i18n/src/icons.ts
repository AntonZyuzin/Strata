import type { Locale } from './index';

/**
 * Words of the icon presets (07 §6.3, ☑ Q-07-21): per game-icons id, the
 * name shown in each language, then the words the palette `Z` also finds it
 * by. The search looks in both languages at once, as the Tab menu's kinds do.
 * Every preset the atlas ships has its words (packages/ui, iconWords.test.ts).
 */
export const ICON_WORDS: Record<string, Record<Locale, readonly string[]>> = {
  'lorc/open-book': {
    ru: ['Открытая книга', 'книга', 'чтение', 'документ'],
    en: ['Open book', 'book', 'reading', 'docs'],
  },
  'lorc/book-cover': { ru: ['Книга', 'обложка', 'том'], en: ['Book cover', 'book', 'volume'] },
  'lorc/bookmarklet': {
    ru: ['Закладка в книге', 'книга', 'метка'],
    en: ['Bookmarked book', 'bookmark', 'marker'],
  },
  'lorc/key': { ru: ['Ключ', 'доступ', 'пароль'], en: ['Key', 'access', 'password'] },
  'lorc/skeleton-key': {
    ru: ['Старинный ключ', 'ключ', 'отмычка'],
    en: ['Skeleton key', 'key', 'old'],
  },
  'lorc/heart-organ': {
    ru: ['Сердце', 'анатомия', 'здоровье'],
    en: ['Heart', 'anatomy', 'health'],
  },
  'delapouite/eye-target': {
    ru: ['Глаз в прицеле', 'цель', 'фокус', 'наблюдение'],
    en: ['Eye target', 'aim', 'focus', 'watch'],
  },
  'lorc/eyeball': { ru: ['Глаз', 'взгляд', 'обзор'], en: ['Eyeball', 'eye', 'view'] },
  'lorc/hourglass': {
    ru: ['Песочные часы', 'время', 'срок', 'ожидание'],
    en: ['Hourglass', 'time', 'deadline', 'wait'],
  },
  'lorc/compass': {
    ru: ['Компас', 'направление', 'проект', 'путь'],
    en: ['Compass', 'direction', 'project', 'way'],
  },
  'delapouite/house': { ru: ['Дом', 'жильё', 'здание'], en: ['House', 'home', 'building'] },
  'lorc/tree-branch': {
    ru: ['Ветка', 'дерево', 'иерархия'],
    en: ['Tree branch', 'tree', 'hierarchy'],
  },
  'lorc/envelope': { ru: ['Конверт', 'письмо', 'почта'], en: ['Envelope', 'mail', 'letter'] },
  'lorc/quill-ink': {
    ru: ['Перо и чернила', 'заметка', 'письмо'],
    en: ['Quill and ink', 'note', 'writing'],
  },
  'lorc/scroll-unfurled': {
    ru: ['Свиток', 'список', 'документ'],
    en: ['Scroll', 'list', 'document'],
  },
  'lorc/candle-light': { ru: ['Свеча', 'свет', 'огонь'], en: ['Candle light', 'candle', 'light'] },
  'lorc/lantern-flame': { ru: ['Фонарь', 'свет', 'огонь'], en: ['Lantern', 'light', 'flame'] },
  'lorc/skull-crossed-bones': {
    ru: ['Череп с костями', 'опасность', 'яд'],
    en: ['Skull and bones', 'danger', 'poison'],
  },
  'lorc/crown': { ru: ['Корона', 'король', 'главное'], en: ['Crown', 'king', 'top'] },
  'lorc/anchor': { ru: ['Якорь', 'море', 'опора'], en: ['Anchor', 'sea', 'hold'] },
  'lorc/ringing-bell': {
    ru: ['Колокол', 'звонок', 'напоминание'],
    en: ['Ringing bell', 'bell', 'reminder'],
  },
  'lorc/bottle-vapors': {
    ru: ['Склянка', 'зелье', 'химия'],
    en: ['Bottle vapors', 'potion', 'chemistry'],
  },
  'delapouite/stone-bridge': {
    ru: ['Каменный мост', 'мост', 'связь'],
    en: ['Stone bridge', 'bridge', 'link'],
  },
  'lorc/castle': { ru: ['Замок', 'крепость'], en: ['Castle', 'fortress'] },
  'delapouite/chest': { ru: ['Сундук', 'хранилище'], en: ['Chest', 'storage'] },
  'delapouite/coins': { ru: ['Монеты', 'деньги', 'бюджет'], en: ['Coins', 'money', 'budget'] },
  'lorc/crystal-growth': {
    ru: ['Кристаллы', 'камень', 'рост'],
    en: ['Crystal growth', 'crystal', 'gem'],
  },
  'lorc/feather': { ru: ['Птичье перо', 'птица', 'лёгкость'], en: ['Feather', 'bird', 'light'] },
  'sbed/fire': { ru: ['Огонь', 'пламя', 'срочно'], en: ['Fire', 'flame', 'urgent'] },
  'delapouite/flower-emblem': { ru: ['Цветок', 'эмблема'], en: ['Flower emblem', 'flower'] },
  'lorc/gears': {
    ru: ['Шестерни', 'механизм', 'настройки'],
    en: ['Gears', 'mechanism', 'settings'],
  },
  'lorc/globe': { ru: ['Глобус', 'мир', 'сеть'], en: ['Globe', 'world', 'web'] },
  'lorc/hammer-nails': {
    ru: ['Молоток и гвозди', 'ремонт', 'сборка'],
    en: ['Hammer and nails', 'build', 'fix'],
  },
  'lorc/hand': { ru: ['Ладонь', 'рука', 'стоп'], en: ['Hand', 'palm', 'stop'] },
  'delapouite/harp': { ru: ['Арфа', 'музыка'], en: ['Harp', 'music'] },
  'lorc/horse-head': { ru: ['Голова коня', 'лошадь'], en: ['Horse head', 'horse'] },
  'lorc/ink-swirl': { ru: ['Чернильный вихрь', 'узор'], en: ['Ink swirl', 'pattern'] },
  'delapouite/ladder': { ru: ['Стремянка', 'лестница', 'подъём'], en: ['Ladder', 'climb'] },
  'lorc/desk-lamp': {
    ru: ['Настольная лампа', 'свет', 'работа'],
    en: ['Desk lamp', 'light', 'work'],
  },
  'delapouite/oak-leaf': {
    ru: ['Дубовый лист', 'лист', 'природа'],
    en: ['Oak leaf', 'leaf', 'nature'],
  },
  'lorc/padlock': {
    ru: ['Навесной замок', 'защита', 'закрыто'],
    en: ['Padlock', 'lock', 'secure'],
  },
  'lorc/magnifying-glass': {
    ru: ['Лупа', 'поиск', 'исследование'],
    en: ['Magnifying glass', 'search', 'research'],
  },
  'lorc/treasure-map': {
    ru: ['Карта сокровищ', 'карта', 'план'],
    en: ['Treasure map', 'map', 'plan'],
  },
  'lorc/drama-masks': {
    ru: ['Театральные маски', 'театр', 'роли'],
    en: ['Drama masks', 'theatre', 'roles'],
  },
  'lorc/moon': { ru: ['Луна', 'ночь'], en: ['Moon', 'night'] },
  'lorc/mountains': { ru: ['Горы', 'пейзаж', 'цель'], en: ['Mountains', 'landscape', 'goal'] },
  'lorc/mushroom': { ru: ['Гриб', 'лес'], en: ['Mushroom', 'forest'] },
  'lorc/sewing-needle': { ru: ['Игла', 'шитьё'], en: ['Sewing needle', 'sewing'] },
  'lorc/owl': { ru: ['Сова', 'мудрость', 'ночь'], en: ['Owl', 'wisdom', 'night'] },
  'lorc/fountain-pen': {
    ru: ['Перьевая ручка', 'письмо', 'подпись'],
    en: ['Fountain pen', 'writing', 'signature'],
  },
  'lorc/potion-ball': { ru: ['Зелье', 'колба', 'магия'], en: ['Potion', 'flask', 'magic'] },
  'lorc/raven': { ru: ['Ворон', 'птица'], en: ['Raven', 'bird'] },
  'delapouite/ring': { ru: ['Кольцо', 'украшение'], en: ['Ring', 'jewellery'] },
  'lorc/rose': { ru: ['Роза', 'цветок', 'любовь'], en: ['Rose', 'flower', 'love'] },
  'lorc/rune-stone': { ru: ['Рунный камень', 'руна', 'знак'], en: ['Rune stone', 'rune', 'sign'] },
  'lorc/scales': {
    ru: ['Весы', 'решение', 'баланс', 'право'],
    en: ['Scales', 'decision', 'balance', 'justice'],
  },
  'lorc/scissors': { ru: ['Ножницы', 'резать'], en: ['Scissors', 'cut'] },
  'delapouite/sailboat': { ru: ['Парусник', 'лодка', 'море'], en: ['Sailboat', 'boat', 'sea'] },
  'delapouite/star-formation': {
    ru: ['Звёзды', 'созвездие'],
    en: ['Star formation', 'stars', 'constellation'],
  },
  'lorc/sun': { ru: ['Солнце', 'день'], en: ['Sun', 'day'] },
  'delapouite/telescope': {
    ru: ['Телескоп', 'астрономия', 'обзор'],
    en: ['Telescope', 'astronomy'],
  },
  'delapouite/tower-flag': {
    ru: ['Башня с флагом', 'башня', 'веха'],
    en: ['Tower flag', 'tower', 'milestone'],
  },
  'delapouite/steam-locomotive': { ru: ['Паровоз', 'поезд'], en: ['Steam locomotive', 'train'] },
  'lorc/umbrella': { ru: ['Зонт', 'дождь', 'защита'], en: ['Umbrella', 'rain', 'cover'] },
  'lorc/cog': { ru: ['Шестерня', 'настройка'], en: ['Cog', 'gear', 'settings'] },
  'delapouite/windmill': { ru: ['Мельница', 'ветер'], en: ['Windmill', 'wind'] },
  'lorc/wolf-head': { ru: ['Волк', 'зверь'], en: ['Wolf head', 'wolf'] },
  'lorc/bull': { ru: ['Бык', 'сила'], en: ['Bull', 'strength'] },
  'delapouite/rat': { ru: ['Крыса', 'мышь'], en: ['Rat', 'mouse'] },
  'lorc/cat': { ru: ['Кот', 'кошка'], en: ['Cat'] },
  'delapouite/alarm-clock': {
    ru: ['Будильник', 'время', 'срок'],
    en: ['Alarm clock', 'time', 'deadline'],
  },
  'delapouite/calendar': {
    ru: ['Календарь', 'дата', 'план'],
    en: ['Calendar', 'date', 'schedule'],
  },
  'lorc/brain': { ru: ['Мозг', 'идея', 'мысль'], en: ['Brain', 'idea', 'mind'] },
  'lord-berandas/microscope': { ru: ['Микроскоп', 'наука'], en: ['Microscope', 'science'] },
  'skoll/chess-knight': {
    ru: ['Шахматный конь', 'шахматы', 'стратегия'],
    en: ['Chess knight', 'chess', 'strategy'],
  },
  'delapouite/card-joker': { ru: ['Джокер', 'карта', 'игра'], en: ['Joker card', 'card', 'game'] },
  'delapouite/paint-brush': {
    ru: ['Кисть', 'рисунок', 'краска'],
    en: ['Paint brush', 'paint', 'art'],
  },
  'delapouite/palette': {
    ru: ['Палитра', 'цвет', 'художник', 'доска'],
    en: ['Palette', 'colour', 'art', 'board'],
  },
  'delapouite/photo-camera': {
    ru: ['Фотоаппарат', 'фото', 'снимок'],
    en: ['Photo camera', 'photo', 'picture'],
  },
  'delapouite/film-strip': { ru: ['Плёнка', 'кино', 'видео'], en: ['Film strip', 'film', 'video'] },
  'delapouite/musical-notes': {
    ru: ['Ноты', 'музыка', 'звук'],
    en: ['Musical notes', 'music', 'sound'],
  },
  'lorc/guitar': { ru: ['Гитара', 'музыка'], en: ['Guitar', 'music'] },
  'delapouite/drum': { ru: ['Барабан', 'ритм'], en: ['Drum', 'rhythm'] },
  'delapouite/newspaper': {
    ru: ['Газета', 'новости', 'статья'],
    en: ['Newspaper', 'news', 'article'],
  },
  'delapouite/church': { ru: ['Церковь', 'храм'], en: ['Church', 'temple'] },
  'delapouite/bread': { ru: ['Хлеб', 'еда'], en: ['Bread', 'food'] },
  'lorc/grapes': { ru: ['Виноград', 'фрукты'], en: ['Grapes', 'fruit'] },
  'lorc/wine-glass': { ru: ['Бокал', 'вино'], en: ['Wine glass', 'wine'] },
  'delapouite/coffee-cup': {
    ru: ['Чашка кофе', 'кофе', 'перерыв'],
    en: ['Coffee cup', 'coffee', 'break'],
  },
  'delapouite/cooking-pot': {
    ru: ['Кастрюля', 'готовка', 'рецепт'],
    en: ['Cooking pot', 'cooking', 'recipe'],
  },
  'lorc/knife-fork': {
    ru: ['Нож и вилка', 'еда', 'ресторан'],
    en: ['Knife and fork', 'food', 'restaurant'],
  },
  'delapouite/bed': { ru: ['Кровать', 'сон', 'отдых'], en: ['Bed', 'sleep', 'rest'] },
  'delapouite/door': { ru: ['Дверь', 'вход'], en: ['Door', 'entrance'] },
  'delapouite/window': { ru: ['Окно', 'вид'], en: ['Window', 'view'] },
  'delapouite/table': { ru: ['Стол', 'мебель'], en: ['Table', 'furniture'] },
  'lorc/top-hat': { ru: ['Цилиндр', 'шляпа', 'фокус'], en: ['Top hat', 'hat', 'trick'] },
  'lorc/boots': { ru: ['Сапоги', 'обувь', 'поход'], en: ['Boots', 'shoes', 'hike'] },
  'delapouite/gloves': { ru: ['Перчатки', 'руки'], en: ['Gloves', 'hands'] },
  'lorc/spectacles': { ru: ['Очки', 'чтение', 'зрение'], en: ['Spectacles', 'glasses', 'reading'] },
  'lorc/mirror-mirror': { ru: ['Зеркало', 'отражение'], en: ['Mirror', 'reflection'] },
  'lorc/comb': { ru: ['Расчёска', 'гребень'], en: ['Comb'] },
  'delapouite/kite': { ru: ['Воздушный змей', 'ветер', 'игра'], en: ['Kite', 'wind', 'play'] },
  'delapouite/paper-plane': {
    ru: ['Бумажный самолёт', 'отправить', 'сообщение'],
    en: ['Paper plane', 'send', 'message'],
  },
  'delapouite/camping-tent': {
    ru: ['Палатка', 'поход', 'лагерь'],
    en: ['Camping tent', 'camp', 'hike'],
  },
  'lorc/campfire': { ru: ['Костёр', 'поход', 'огонь'], en: ['Campfire', 'camp', 'fire'] },
  'lorc/wood-axe': { ru: ['Топор', 'дрова'], en: ['Wood axe', 'axe'] },
  'delapouite/well': { ru: ['Колодец', 'вода'], en: ['Well', 'water'] },
  'sbed/water-drop': { ru: ['Капля', 'вода'], en: ['Water drop', 'water'] },
  'lorc/raining': { ru: ['Дождь', 'погода'], en: ['Raining', 'rain', 'weather'] },
  'delapouite/sun-cloud': { ru: ['Солнце и облако', 'погода'], en: ['Sun and cloud', 'weather'] },
  'lorc/snowflake-1': { ru: ['Снежинка', 'зима', 'холод'], en: ['Snowflake', 'winter', 'cold'] },
  'lorc/tornado': { ru: ['Смерч', 'буря'], en: ['Tornado', 'storm'] },
  'lorc/volcano': { ru: ['Вулкан', 'извержение'], en: ['Volcano', 'eruption'] },
  'delapouite/cave-entrance': {
    ru: ['Пещера', 'вход', 'подземелье'],
    en: ['Cave entrance', 'cave', 'dungeon'],
  },
  'delapouite/desert': { ru: ['Пустыня', 'песок'], en: ['Desert', 'sand'] },
  'delapouite/island': { ru: ['Остров', 'море', 'отпуск'], en: ['Island', 'sea', 'holiday'] },
  'delapouite/lighthouse': { ru: ['Маяк', 'ориентир'], en: ['Lighthouse', 'beacon'] },
  'delapouite/factory': { ru: ['Завод', 'производство'], en: ['Factory', 'production'] },
  'delapouite/valve': { ru: ['Вентиль', 'кран', 'труба'], en: ['Valve', 'tap', 'pipe'] },
  'sbed/battery-pack': {
    ru: ['Батарея', 'энергия', 'заряд'],
    en: ['Battery pack', 'energy', 'charge'],
  },
  'lorc/light-bulb': { ru: ['Лампочка', 'идея'], en: ['Light bulb', 'idea'] },
  'delapouite/radio-tower': {
    ru: ['Радиовышка', 'сигнал', 'связь'],
    en: ['Radio tower', 'signal', 'broadcast'],
  },
  'delapouite/phone': { ru: ['Телефон', 'звонок'], en: ['Phone', 'call'] },
  'delapouite/tv': { ru: ['Телевизор', 'экран', 'видео'], en: ['TV', 'screen', 'video'] },
  'lorc/robot-golem': {
    ru: ['Робот', 'голем', 'автоматизация'],
    en: ['Robot golem', 'robot', 'automation'],
  },
  'lorc/alien-skull': { ru: ['Пришелец', 'инопланетянин'], en: ['Alien skull', 'alien'] },
  'lorc/ghost': { ru: ['Привидение', 'дух'], en: ['Ghost', 'spirit'] },
  'delapouite/devil-mask': { ru: ['Маска демона', 'чёрт'], en: ['Devil mask', 'demon'] },
  'lorc/angel-wings': { ru: ['Крылья ангела', 'крылья'], en: ['Angel wings', 'wings'] },
  'lorc/dragon-head': { ru: ['Дракон', 'чудовище'], en: ['Dragon head', 'dragon', 'monster'] },
  'delapouite/unicorn': { ru: ['Единорог', 'сказка'], en: ['Unicorn', 'fairy tale'] },
  'delapouite/mermaid': { ru: ['Русалка', 'море', 'сказка'], en: ['Mermaid', 'sea'] },
  'lorc/fairy': { ru: ['Фея', 'сказка', 'магия'], en: ['Fairy', 'magic'] },
  'lorc/wizard-staff': {
    ru: ['Посох мага', 'магия', 'волшебник'],
    en: ['Wizard staff', 'magic', 'wizard'],
  },
  'lorc/witch-flight': {
    ru: ['Ведьма на метле', 'ведьма', 'полёт'],
    en: ['Witch flight', 'witch', 'broom'],
  },
  'delapouite/knight-banner': {
    ru: ['Знамя рыцаря', 'флаг', 'рыцарь'],
    en: ['Knight banner', 'flag', 'knight'],
  },
  'lorc/king': { ru: ['Король', 'правитель'], en: ['King', 'ruler'] },
  'lorc/queen-crown': { ru: ['Королева', 'корона'], en: ['Queen crown', 'queen'] },
  'lorc/doctor-face': { ru: ['Доктор', 'врач'], en: ['Doctor face', 'doctor', 'medic'] },
  'lorc/pill': { ru: ['Таблетка', 'лекарство'], en: ['Pill', 'medicine'] },
  'lorc/syringe': { ru: ['Шприц', 'укол', 'прививка'], en: ['Syringe', 'injection', 'vaccine'] },
  'lorc/bandage-roll': {
    ru: ['Бинт', 'перевязка', 'помощь'],
    en: ['Bandage roll', 'bandage', 'first aid'],
  },
  'lorc/virus': { ru: ['Вирус', 'болезнь', 'баг'], en: ['Virus', 'disease', 'bug'] },
  'lorc/dna1': { ru: ['ДНК', 'генетика'], en: ['DNA', 'genetics'] },
  'skoll/atom': { ru: ['Атом', 'физика', 'наука'], en: ['Atom', 'physics', 'science'] },
  'lorc/round-bottom-flask': {
    ru: ['Колба', 'химия', 'опыт'],
    en: ['Round-bottom flask', 'chemistry', 'experiment'],
  },
  'lorc/test-tubes': { ru: ['Пробирки', 'лаборатория', 'тест'], en: ['Test tubes', 'lab', 'test'] },
  'lorc/magnet': { ru: ['Магнит', 'притяжение'], en: ['Magnet', 'attraction'] },
  'delapouite/pencil': { ru: ['Карандаш', 'правка', 'рисунок'], en: ['Pencil', 'edit', 'draw'] },
  'delapouite/stamper': {
    ru: ['Штамп', 'печать', 'одобрено'],
    en: ['Stamper', 'stamp', 'approved'],
  },
  'lorc/wax-seal': {
    ru: ['Сургучная печать', 'печать', 'письмо'],
    en: ['Wax seal', 'seal', 'letter'],
  },
  'delapouite/money-stack': {
    ru: ['Пачка денег', 'деньги', 'бюджет'],
    en: ['Money stack', 'money', 'budget'],
  },
  'delapouite/wallet': {
    ru: ['Кошелёк', 'деньги', 'расходы'],
    en: ['Wallet', 'money', 'expenses'],
  },
  'delapouite/bank': { ru: ['Банк', 'финансы'], en: ['Bank', 'finance'] },
  'lorc/quill': { ru: ['Перо для письма', 'запись'], en: ['Quill', 'writing'] },
  'skoll/pocket-watch': { ru: ['Карманные часы', 'время'], en: ['Pocket watch', 'time'] },
  'delapouite/scroll-quill': {
    ru: ['Свиток и перо', 'договор', 'документ'],
    en: ['Scroll and quill', 'contract', 'document'],
  },
  'lorc/cauldron': { ru: ['Котёл', 'зелье', 'варка'], en: ['Cauldron', 'brew', 'potion'] },
  'lorc/candle-holder': { ru: ['Подсвечник', 'свеча'], en: ['Candle holder', 'candle'] },
  'delapouite/bookshelf': { ru: ['Книжная полка', 'библиотека'], en: ['Bookshelf', 'library'] },
  'delapouite/family-tree': {
    ru: ['Родословное дерево', 'иерархия', 'папка', 'структура'],
    en: ['Family tree', 'hierarchy', 'folder', 'structure'],
  },
  'delapouite/family-house': {
    ru: ['Семейный дом', 'семья', 'дом'],
    en: ['Family house', 'family', 'home'],
  },
  'delapouite/apple-core': { ru: ['Огрызок яблока', 'яблоко'], en: ['Apple core', 'apple'] },
  'lorc/lightning-arc': {
    ru: ['Молния', 'разряд', 'энергия'],
    en: ['Lightning arc', 'lightning', 'energy'],
  },
  'delapouite/fish-bucket': { ru: ['Ведро с рыбой', 'рыбалка'], en: ['Fish bucket', 'fishing'] },
  'caro-asercion/pipe-organ': { ru: ['Орган', 'музыка'], en: ['Pipe organ', 'organ', 'music'] },
  'delapouite/dog-house': { ru: ['Будка', 'собака'], en: ['Dog house', 'dog'] },
  'delapouite/hanging-sign': {
    ru: ['Вывеска', 'знак', 'магазин'],
    en: ['Hanging sign', 'sign', 'shop'],
  },
  'lorc/crow-dive': { ru: ['Ворона в полёте', 'птица'], en: ['Crow dive', 'crow', 'bird'] },
  'delapouite/crowbar': { ru: ['Лом', 'монтировка'], en: ['Crowbar'] },
  'delapouite/chestnut-leaf': {
    ru: ['Каштановый лист', 'лист', 'осень'],
    en: ['Chestnut leaf', 'leaf', 'autumn'],
  },
  'delapouite/baby-face': { ru: ['Младенец', 'ребёнок'], en: ['Baby face', 'baby', 'child'] },
  'lorc/candle-flame': { ru: ['Пламя свечи', 'свеча'], en: ['Candle flame', 'candle'] },
  'lorc/spider-web': { ru: ['Паутина', 'паук', 'сеть'], en: ['Spider web', 'spider', 'web'] },
  'lorc/bookmark': { ru: ['Закладка', 'метка'], en: ['Bookmark', 'marker'] },
  'delapouite/notebook': { ru: ['Блокнот', 'заметки', 'тетрадь'], en: ['Notebook', 'notes'] },
  'delapouite/hand-saw': { ru: ['Ножовка', 'пила'], en: ['Hand saw', 'saw'] },
  'delapouite/wheelbarrow': { ru: ['Тачка', 'стройка'], en: ['Wheelbarrow', 'construction'] },
  'delapouite/pitchfork': { ru: ['Вилы', 'сено', 'ферма'], en: ['Pitchfork', 'farm'] },
  'delapouite/sickle': { ru: ['Серп', 'урожай'], en: ['Sickle', 'harvest'] },
  'delapouite/plow': { ru: ['Плуг', 'поле', 'ферма'], en: ['Plow', 'field', 'farm'] },
  'lorc/anvil': { ru: ['Наковальня', 'кузница'], en: ['Anvil', 'forge', 'smith'] },
  'delapouite/bellows': { ru: ['Мехи', 'кузница', 'воздух'], en: ['Bellows', 'forge'] },
  'lorc/sundial': { ru: ['Солнечные часы', 'время'], en: ['Sundial', 'time'] },
  'delapouite/globe-ring': { ru: ['Глобус с кольцом', 'планета'], en: ['Globe ring', 'planet'] },
  'lorc/world': { ru: ['Мир', 'планета', 'Земля'], en: ['World', 'planet', 'Earth'] },
  'caro-asercion/astrolabe': {
    ru: ['Астролябия', 'навигация', 'звёзды'],
    en: ['Astrolabe', 'navigation', 'stars'],
  },
  'delapouite/sextant': { ru: ['Секстант', 'навигация'], en: ['Sextant', 'navigation'] },
  'lorc/spyglass': { ru: ['Подзорная труба', 'обзор', 'разведка'], en: ['Spyglass', 'lookout'] },
  'delapouite/keyring': { ru: ['Связка ключей', 'ключи'], en: ['Keyring', 'keys'] },
  'lorc/locked-chest': {
    ru: ['Запертый сундук', 'сундук', 'тайна'],
    en: ['Locked chest', 'chest', 'secret'],
  },
  'skoll/open-chest': {
    ru: ['Открытый сундук', 'сундук', 'клад'],
    en: ['Open chest', 'chest', 'treasure'],
  },
  'delapouite/jewel-crown': {
    ru: ['Корона с камнями', 'драгоценности'],
    en: ['Jewel crown', 'jewels'],
  },
  'delapouite/diamond-ring': {
    ru: ['Кольцо с бриллиантом', 'свадьба'],
    en: ['Diamond ring', 'wedding'],
  },
  'delapouite/heart-key': {
    ru: ['Ключ-сердце', 'любовь', 'ключ'],
    en: ['Heart key', 'love', 'key'],
  },
  'lorc/heart-bottle': {
    ru: ['Зелье любви', 'сердце', 'флакон'],
    en: ['Heart bottle', 'love potion'],
  },
  'lorc/broken-heart': { ru: ['Разбитое сердце', 'грусть'], en: ['Broken heart', 'sadness'] },
  'lorc/tear-tracks': { ru: ['Слёзы', 'грусть', 'плач'], en: ['Tear tracks', 'tears', 'sad'] },
  'sbed/weight-crush': {
    ru: ['Гиря', 'тяжесть', 'нагрузка'],
    en: ['Weight crush', 'weight', 'load'],
  },
  'delapouite/stairs': { ru: ['Ступени', 'лестница', 'шаги'], en: ['Stairs', 'steps'] },
};

/** A preset's name in the interface's language; its id when it has no words. */
export function iconName(locale: Locale, id: string): string {
  return ICON_WORDS[id]?.[locale][0] ?? id;
}

/** Every word a preset is found by, both languages. */
export function iconTerms(id: string): string[] {
  const w = ICON_WORDS[id];
  return w ? [...w.ru, ...w.en] : [id];
}
