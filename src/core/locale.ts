/**
 * Язык интерфейса.
 *
 * Модуль нужен потому, что форматирование значений используется в двух местах:
 * в расширении (там доступен API локализации VS Code) и внутри панели графиков
 * (обычная страница в webview, без доступа к этому API). Поэтому слова и форматы
 * хранятся здесь: оба места берут их из одного источника.
 */

/** Поддерживаемые языки. */
export type SupportedLocale = 'en' | 'ru';

let activeLocale: SupportedLocale = 'en';

/**
 * Исполнитель перевода строк интерфейса.
 * Расширение подключает сюда `vscode.l10n.t`; в тестах он остаётся по умолчанию и возвращает
 * исходную (английскую) строку, поэтому модули не зависят от API VS Code.
 */
let translator: (message: string) => string = message => message;

/** Подключает исполнителя перевода (в расширении — `vscode.l10n.t`). */
export function setTranslator(next: (message: string) => string): void {
  translator = next;
}

/**
 * Переводит строку интерфейса на текущий язык и подставляет значения.
 * Исходные строки в коде всегда английские: они же служат ключами в словаре переводов.
 */
export function translate(message: string, ...args: Array<string | number>): string {
  return formatTemplate(translator(message), ...args);
}

/** Устанавливает язык по коду локали VS Code (например, `ru` или `en-US`). */
export function configureLocale(locale: string): void {
  activeLocale = locale.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Текущий язык. */
export function getLocale(): SupportedLocale {
  return activeLocale;
}

/** Тег локали для Intl (числа, дата и время). */
export function localeTag(): string {
  return activeLocale === 'ru' ? 'ru-RU' : 'en-US';
}

/** Ключи слов и фраз, которые нужны при форматировании. */
export type LocaleWordKey =
  | 'byte'
  | 'kilobyte'
  | 'megabyte'
  | 'gigabyte'
  | 'terabyte'
  | 'millisecondShort'
  | 'secondShort'
  | 'million'
  | 'billion'
  | 'seriesAverage'
  | 'seriesInterval'
  | 'seriesMin'
  | 'seriesMax'
  | 'seriesType'
  | 'metricKind'
  | 'metricRate'
  | 'metricMeasurements'
  | 'kindCounter'
  | 'kindUpDownCounter'
  | 'kindGauge'
  | 'kindHistogram'
  | 'partSeparator';

/** Тексты для каждого языка. Английский — основной, русский — перевод. */
const WORDS: Record<SupportedLocale, Record<LocaleWordKey, string>> = {
  en: {
    byte: 'B',
    kilobyte: 'KB',
    megabyte: 'MB',
    gigabyte: 'GB',
    terabyte: 'TB',
    millisecondShort: 'ms',
    secondShort: 's',
    million: 'M',
    billion: 'B',
    seriesAverage: 'Average: {0}',
    seriesInterval: 'Interval: {0} s',
    seriesMin: 'Min: {0}',
    seriesMax: 'Max: {0}',
    seriesType: 'Type: {0}',
    metricKind: 'Kind: {0}',
    metricRate: 'Rate: {0}',
    metricMeasurements: 'Measurements: {0}',
    kindCounter: 'counter',
    kindUpDownCounter: 'up/down counter',
    kindGauge: 'gauge',
    kindHistogram: 'histogram',
    partSeparator: ' · ',
  },
  ru: {
    byte: 'Б',
    kilobyte: 'КБ',
    megabyte: 'МБ',
    gigabyte: 'ГБ',
    terabyte: 'ТБ',
    millisecondShort: 'мс',
    secondShort: 'с',
    million: 'млн',
    billion: 'млрд',
    seriesAverage: 'Среднее: {0}',
    seriesInterval: 'Интервал: {0} с',
    seriesMin: 'Мин: {0}',
    seriesMax: 'Макс: {0}',
    seriesType: 'Тип: {0}',
    metricKind: 'Вид: {0}',
    metricRate: 'Прирост: {0}',
    metricMeasurements: 'Измерений: {0}',
    kindCounter: 'счётчик',
    kindUpDownCounter: 'счётчик (вверх/вниз)',
    kindGauge: 'датчик',
    kindHistogram: 'гистограмма',
    partSeparator: ' · ',
  },
};

/** Возвращает слово или фразу текущего языка с подстановкой значений. */
export function word(key: LocaleWordKey, ...args: Array<string | number>): string {
  return formatTemplate(WORDS[activeLocale][key], ...args);
}

/**
 * Подставляет значения в шаблон вида `{0}`.
 * Используется и расширением, и панелью графиков — там свой способ получения текстов.
 */
export function formatTemplate(message: string, ...args: Array<string | number>): string {
  return args.reduce<string>(
    (text, value, index) => text.replace(`{${index}}`, String(value)),
    message,
  );
}
