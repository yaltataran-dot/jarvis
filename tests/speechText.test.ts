import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plural, prepareForSpeech } from '../src/lib/speechText.ts'

const ru = (s: string) => prepareForSpeech(s, 'ru')

test('plural picks the Russian form', () => {
  const forms = ['градус', 'градуса', 'градусов'] as const
  assert.equal(plural(1, ...forms), 'градус')
  assert.equal(plural(3, ...forms), 'градуса')
  assert.equal(plural(5, ...forms), 'градусов')
  assert.equal(plural(11, ...forms), 'градусов')
  assert.equal(plural(21, ...forms), 'градус')
  assert.equal(plural(112, ...forms), 'градусов')
})

test('units are spoken with the right ending', () => {
  assert.equal(ru('Сейчас 23°C'), 'Сейчас 23 градуса.')
  assert.equal(ru('Заряд 5%'), 'Заряд 5 процентов.')
  assert.equal(ru('Рост на 1,5%.'), 'Рост на 1,5 процента.')
  assert.equal(ru('Стоит 101 ₽.'), 'Стоит 101 рубль.')
  assert.equal(ru('Цена $20.'), 'Цена 20 долларов.')
})

test('abbreviations are expanded', () => {
  assert.equal(ru('Почта, календарь и т.д.'), 'Почта, календарь и так далее.')
  assert.equal(ru('Завтра, т.е. в среду.'), 'Завтра, то есть в среду.')
  // The abbreviation's full stop also ended the sentence.
  assert.equal(ru('Почта и т.д. Всё готово.'), 'Почта и так далее. Всё готово.')
  assert.equal(ru('Почта и т.д., всё готово.'), 'Почта и так далее, всё готово.')
})

test('Latin names become pronounceable Russian', () => {
  assert.equal(ru('Открываю GitHub'), 'Открываю Гитхаб.')
  assert.equal(ru('Видео на YouTube готово.'), 'Видео на Ютуб готово.')
})

test('pauses: dashes and brackets become commas', () => {
  assert.equal(ru('Готово — файл сохранён.'), 'Готово, файл сохранён.')
  assert.equal(ru('Встреча (в десять) перенесена.'), 'Встреча, в десять, перенесена.')
  // A hyphen inside a word is not a pause.
  assert.equal(ru('Кто-то звонил.'), 'Кто-то звонил.')
})

test('a line always ends in a terminator', () => {
  assert.equal(ru('Слушаю'), 'Слушаю.')
  assert.equal(ru('Да, сэр?'), 'Да, сэр?')
  assert.equal(ru('Готово,'), 'Готово.')
})

test('emoji and quotes are not read aloud', () => {
  assert.equal(ru('Готово 🚀'), 'Готово.')
  assert.equal(ru('Фильм «Мстители» вышел.'), 'Фильм Мстители вышел.')
})

test('ordinary sentences pass through unchanged', () => {
  const s = 'Плюс двенадцать, облачно, сэр.'
  assert.equal(ru(s), s)
})

test('dates are read as ordinals in the right case', () => {
  assert.equal(ru('Встреча 1 августа.'), 'Встреча первого августа.')
  assert.equal(ru('Сегодня 3 мая.'), 'Сегодня третье мая.')
  assert.equal(ru('Отчёт нужен к 21 марта.'), 'Отчёт нужен к двадцать первому марта.')
  assert.equal(ru('Срок до 12 декабря.'), 'Срок до двенадцатого декабря.')
  assert.equal(ru('Перенесли на 1 августа.'), 'Перенесли на первое августа.')
  assert.equal(ru('Перенесли на 01.08.2026.'), 'Перенесли на первое августа две тысячи двадцать шестого года.')
  // Not a date — left for the voice to read as a number.
  assert.equal(ru('Осталось 45 минут.'), 'Осталось 45 минут.')
})

test('years are read as ordinals', () => {
  assert.equal(ru('Это было в 2026 году.'), 'Это было в две тысячи двадцать шестом году.')
  assert.equal(ru('С 1998 года.'), 'С тысяча девятьсот девяносто восьмого года.')
  assert.equal(ru('Наступил 2027 год.'), 'Наступил две тысячи двадцать седьмой год.')
  assert.equal(ru('В 2026 г. всё изменилось.'), 'В две тысячи двадцать шестом году всё изменилось.')
  // A round year has no simple form here; leave it alone rather than guess.
  assert.equal(ru('В 2000 году.'), 'В 2000 году.')
})

test('ordinal endings', async () => {
  const { ordinal } = await import('../src/lib/speechText.ts')
  assert.equal(ordinal(2, 'nom'), 'второй')
  assert.equal(ordinal(5, 'nom'), 'пятый')
  assert.equal(ordinal(40, 'prep'), 'сороковом')
  assert.equal(ordinal(23, 'gen'), 'двадцать третьего')
  assert.equal(ordinal(100, 'gen'), null)
})

test('unambiguous ё is restored', () => {
  assert.equal(ru('Все готово, сэр.'), 'Всё готово, сэр.')
  assert.equal(ru('Еще минуту.'), 'Ещё минуту.')
  assert.equal(ru('Это все.'), 'Это всё.')
  assert.equal(ru('Все равно не работает.'), 'Всё равно не работает.')
  assert.equal(ru('Все-таки получилось.'), 'Всё-таки получилось.')
  // Plural "все" stays: "все системы", "все, кто пришёл".
  assert.equal(ru('Все системы в норме.'), 'Все системы в норме.')
  assert.equal(ru('Все, кто пришёл, ждут.'), 'Все, кто пришёл, ждут.')
})

test('digit groups, decimals and signs', () => {
  assert.equal(ru('Население 1 000 000 человек.'), 'Население 1000000 человек.')
  assert.equal(ru('Рост на 1.5 процента.'), 'Рост на 1,5 процента.')
  assert.equal(ru('На улице -5°C.'), 'На улице минус 5 градусов.')
  assert.equal(ru('На улице +12°.'), 'На улице +12 градусов.')
  assert.equal(ru('Дом № 5.'), 'Дом номер 5.')
  // A version number keeps its dots.
  assert.equal(ru('Версия 2.0.1 вышла.'), 'Версия 2.0.1 вышла.')
  // A hyphen between numbers is a range, not a minus.
  assert.equal(ru('Займёт 10-15 минут.'), 'Займёт 10-15 минут.')
})

test('thousands, millions and billions', () => {
  assert.equal(ru('Бюджет 2 тыс. рублей.'), 'Бюджет 2000 рублей.')
  assert.equal(ru('Это 1,5 млн.'), 'Это 1500000.')
  assert.equal(ru('Выручка 3 млрд рублей.'), 'Выручка 3000000000 рублей.')
})

test('numeric dates', () => {
  assert.equal(ru('Встреча 01.08.2026.'), 'Встреча первого августа две тысячи двадцать шестого года.')
  assert.equal(ru('Сегодня 03.05.2026.'), 'Сегодня третье мая две тысячи двадцать шестого года.')
  // Not a date.
  assert.equal(ru('Счёт 45.99.1234.'), 'Счёт 45.99.1234.')
})

test('ordinal suffixes', () => {
  assert.equal(ru('Он занял 2-е место.'), 'Он занял второе место.')
  assert.equal(ru('Встреча 1-го августа.'), 'Встреча первого августа.')
  assert.equal(ru('На 3-м этаже.'), 'На третьем этаже.')
  assert.equal(ru('С 3-м участником.'), 'С третьим участником.')
  assert.equal(ru('Это 5-я попытка.'), 'Это пятая попытка.')
  assert.equal(ru('Нажмите 2-ю кнопку.'), 'Нажмите вторую кнопку.')
  assert.equal(ru('В 90-е годы.'), 'В девяностые годы.')
  assert.equal(ru('В 1990-х годах.'), 'В тысяча девятьсот девяностых годах.')
  assert.equal(ru('С 2026-го года.'), 'С две тысячи двадцать шестого года.')
  assert.equal(ru('Это 21-й век.'), 'Это двадцать первый век.')
  assert.equal(ru('Это 2-й раз.'), 'Это второй раз.')
})

test('units after numbers', () => {
  assert.equal(ru('Скорость 60 км/ч.'), 'Скорость 60 километров в час.')
  assert.equal(ru('Ветер 5 м/с.'), 'Ветер 5 метров в секунду.')
  assert.equal(ru('Вес 1 кг, длина 3 м.'), 'Вес 1 килограмм, длина 3 метра.')
  assert.equal(ru('Файл 3 ГБ, свободно 512 МБ.'), 'Файл 3 гигабайта, свободно 512 мегабайт.')
  assert.equal(ru('Ехать 25 мин.'), 'Ехать 25 минут.')
  assert.equal(ru('Через 5 мин. начнём.'), 'Через 5 минут начнём.')
  // No full stop left in mid-phrase before a comma.
  assert.equal(ru('Ехать 25 мин., ветер 5 м/с.'), 'Ехать 25 минут, ветер 5 метров в секунду.')
  assert.equal(ru('Бюджет 2 тыс., срок неделя.'), 'Бюджет 2000, срок неделя.')
  assert.equal(ru('Почта, звонки и т. д., всё проверено.'), 'Почта, звонки и так далее, всё проверено.')
  // "см." before a number-free word is still "смотрите".
  assert.equal(ru('Подробнее см. выше.'), 'Подробнее смотрите выше.')
  // …and "5 см." is centimetres even at the end of a sentence.
  assert.equal(ru('Длина 5 см. Готово.'), 'Длина 5 сантиметров. Готово.')
})

test('feminine and neuter nouns agree with one and two', () => {
  assert.equal(ru('Осталось 2 минуты.'), 'Осталось две минуты.')
  assert.equal(ru('Осталась 1 минута.'), 'Осталась одна минута.')
  assert.equal(ru('Подождите 1 минуту.'), 'Подождите одну минуту.')
  assert.equal(ru('Через 21 секунду.'), 'Через 20 одну секунду.')
  assert.equal(ru('У вас 2 встречи.'), 'У вас две встречи.')
  assert.equal(ru('Свободно 1 место.'), 'Свободно одно место.')
  assert.equal(ru('Пришло 1 сообщение.'), 'Пришло одно сообщение.')
  // Masculine nouns and 11/12 are left to the voice, which reads them right.
  assert.equal(ru('До 1 часа ночи.'), 'До 1 часа ночи.')
  assert.equal(ru('Прошло 2 дня.'), 'Прошло 2 дня.')
  assert.equal(ru('Осталось 12 минут.'), 'Осталось 12 минут.')
  // Units become words first, then agree: "2 мин" → "две минуты".
  assert.equal(ru('Ждать 2 мин.'), 'Ждать две минуты.')
})

test('Latin words, acronyms and letters', () => {
  assert.equal(ru('Работа с API и USB.'), 'Работа с эй-пи-ай и ю-эс-би.')
  assert.equal(ru('Документ PDF.'), 'Документ пэ-дэ-эф.')
  assert.equal(ru('Модель Python и Microsoft.'), 'Модель Пайтон и Майкрософт.')
  assert.equal(ru('Откройте Figma и Slack.'), 'Откройте Фигма и Слак.')
  assert.equal(ru('Это план B.'), 'Это план би.')
  assert.equal(ru('Новости США.'), 'Новости сэ-шэ-а.')
  assert.equal(ru('Отчёт от J.A.R.V.I.S.'), 'Отчёт от Джарвис.')
  // Russian acronyms the voice already spells correctly are left alone.
  assert.equal(ru('Учился в МГУ.'), 'Учился в МГУ.')
  // No Latin letters survive to be read with English phonemes.
  assert.ok(!/[A-Za-z]/.test(ru('Запусти Docker, Notion и Spotify на MacBook.')))
})

test('punctuation that reads badly', () => {
  assert.equal(ru('Привет!!! Как дела?!'), 'Привет! Как дела?')
  assert.equal(ru('Первое; второе.'), 'Первое, второе.')
  assert.equal(ru('Чай & кофе.'), 'Чай и кофе.')
})

test('English mode keeps English expansions', () => {
  assert.equal(prepareForSpeech('Battery at 5%', 'en'), 'Battery at 5 percent.')
})
