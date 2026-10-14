import { test } from 'node:test'
import assert from 'node:assert/strict'
import { musicReply, parseMusicCommand, parseYesNo } from '../src/lib/musicIntent.ts'

const p = parseMusicCommand

test('opening and starting music', () => {
  assert.deepEqual(p('Юг-Трансфер, включи Яндекс Музыку'), { action: 'play' })
  assert.deepEqual(p('Включи музыку'), { action: 'play' })
  assert.deepEqual(p('Открой Яндекс Музыку'), { action: 'open' })
  assert.deepEqual(p('Продолжи музыку'), { action: 'play' })
  assert.deepEqual(p('сними с паузы'), { action: 'play' })
  assert.deepEqual(p('Перезапусти Яндекс Музыку'), { action: 'restart' })
})

test('pause and stop', () => {
  for (const s of ['Пауза', 'Пауза.', 'Поставь на паузу', 'Выключи музыку', 'Останови песню', 'музыку на паузу', 'стоп музыка']) {
    assert.deepEqual(p(s), { action: 'pause' }, s)
  }
})

test('next and previous track', () => {
  for (const s of ['Следующий трек', 'следующая песня', 'Включи следующую песню', 'переключи трек', 'другую песню']) {
    assert.deepEqual(p(s), { action: 'next' }, s)
  }
  for (const s of ['Предыдущий трек', 'прошлую песню', 'верни трек назад']) {
    assert.deepEqual(p(s), { action: 'prev' }, s)
  }
})

test('volume', () => {
  for (const s of ['Сделай громче', 'погромче', 'сделай музыку погромче', 'прибавь громкость', 'ещё громче']) {
    assert.deepEqual(p(s), { action: 'volume', delta: 1 }, s)
  }
  for (const s of ['Уменьши громкость', 'потише', 'сделай тише', 'убавь звук', 'громкость ниже']) {
    assert.deepEqual(p(s), { action: 'volume', delta: -1 }, s)
  }
  assert.deepEqual(p('громкость 40 процентов'), { action: 'volume', set: 40 })
  assert.deepEqual(p('поставь громкость на 70'), { action: 'volume', set: 70 })
})

test('what is playing', () => {
  for (const s of ['Что сейчас играет?', 'что это за песня', 'как называется эта песня', 'какой трек играет']) {
    assert.deepEqual(p(s), { action: 'now' }, s)
  }
})

test('playing and finding something by name', () => {
  assert.deepEqual(p('Включи песню Группа крови'), { action: 'search', query: 'группа крови', kind: 'track', play: true })
  assert.deepEqual(p('Поставь альбом Nevermind'), { action: 'search', query: 'nevermind', kind: 'album', play: true })
  assert.deepEqual(p('Найди песни Земфиры'), { action: 'search', query: 'земфиры', kind: 'artist', play: false })
  assert.deepEqual(p('Включи группу Кино'), { action: 'search', query: 'кино', kind: 'artist', play: true })
  assert.deepEqual(p('Включи Rammstein в Яндекс Музыке'), { action: 'search', query: 'rammstein', kind: 'any', play: true })
  assert.deepEqual(p('найди Кино на Яндекс Музыке'), { action: 'search', query: 'кино', kind: 'any', play: false })
})

test('plainly about music but nothing named: ask', () => {
  assert.deepEqual(p('Включи песню'), { action: 'clarify', kind: 'track', play: true })
  assert.deepEqual(p('найди альбом'), { action: 'clarify', kind: 'album', play: false })
})

test('not music: left to the model', () => {
  for (const s of [
    'Включи камеру',
    'включи свет',
    'Открой блокнот',
    'Найди файл effort',
    'Говори громче',
    'Следующий вопрос',
    'Продолжи',
    'Покажи папку проекта',
    'стоп',
    'что нового в мире',
    'Расскажи про группу Кино',
    'включи',
    'выключи',
  ]) {
    assert.equal(p(s), null, s)
  }
})

test('«Мне нравится» — every way of asking for it — is the liked playlist, never a search', () => {
  for (const s of [
    'Джарвис, включи Мне нравится',
    'Джарвис, включи мои любимые песни',
    'Джарвис, включи мой плейлист с лайками',
    'Джарвис, включи избранное в Яндекс Музыке',
    'Джарвис, продолжи мой плейлист Мне нравится',
    'поставь понравившиеся треки',
  ]) {
    assert.deepEqual(p(s), { action: 'playlist', liked: true, play: true }, s)
  }
})

test('the user\'s other playlists, by name', () => {
  assert.deepEqual(p('Включи мой плейлист Дорога'), { action: 'playlist', name: 'дорога', play: true })
  assert.deepEqual(p('Запусти плейлист Для работы'), { action: 'playlist', name: 'для работы', play: true })
  assert.deepEqual(p('Найди мой плейлист Любимые песни'), { action: 'playlist', name: 'любимые песни', play: false })
  assert.deepEqual(p('включи плейлист'), { action: 'clarify', kind: 'playlist', play: true })
})

test('a song is not a playlist, even with the same words', () => {
  assert.deepEqual(p('Включи песню Мне нравится'), { action: 'search', query: 'мне нравится', kind: 'track', play: true })
  assert.deepEqual(p('Найди песню Кукушка'), { action: 'search', query: 'кукушка', kind: 'track', play: false })
  assert.deepEqual(p('Включи трек Кукушка исполнителя Кино'), { action: 'search', query: 'кукушка кино', kind: 'track', play: true })
})

test('who is playing', () => {
  for (const s of ['Кто исполнитель?', 'Какая песня сейчас?', 'Что играет?']) assert.deepEqual(p(s), { action: 'now' }, s)
})

test('bare "продолжи", "дальше" are music only while music is the subject', () => {
  assert.equal(p('Продолжи'), null)
  assert.equal(p('Дальше'), null)
  assert.deepEqual(p('Продолжи', { inMusic: true }), { action: 'play' })
  assert.deepEqual(p('Дальше', { inMusic: true }), { action: 'next' })
  assert.deepEqual(p('предыдущий', { inMusic: true }), { action: 'prev' })
  // Other commands stay what they were, music or not.
  assert.equal(p('Включи камеру', { inMusic: true }), null)
  assert.equal(p('Открой блокнот', { inMusic: true }), null)
})

test('yes and no after "включить?"', () => {
  assert.equal(parseYesNo('Да'), 'yes')
  assert.equal(parseYesNo('давай'), 'yes')
  assert.equal(parseYesNo('нет, не надо'), null)
  assert.equal(parseYesNo('не надо'), 'no')
  assert.equal(parseYesNo('включи камеру'), null)
})

test('the reply says what happened, never more', () => {
  const play = { action: 'play' } as const
  assert.equal(musicReply(play, { code: 'ok', playing: true, title: 'Группа крови', artist: 'КИНО' }), 'Включаю: «Группа крови», КИНО.')
  assert.equal(musicReply(play, { code: 'unconfirmed' }), 'Команду отправил, но музыка не включилась.')
  assert.equal(musicReply({ action: 'pause' }, { code: 'unconfirmed' }), 'Не получилось поставить на паузу — музыка всё ещё играет.')
  assert.equal(musicReply({ action: 'prev' }, { code: 'unconfirmed' }), 'Трек не переключился.')
  assert.equal(musicReply({ action: 'volume', delta: 1 }, { code: 'unconfirmed' }), 'Громкость не изменилась.')
  assert.equal(musicReply(play, { code: 'bridge' }), 'Нет связи с модулем управления — музыкой сейчас управлять не могу.')
  assert.equal(musicReply({ action: 'next' }, { code: 'not-running' }), 'Яндекс Музыка не запущена. Скажите «включи Яндекс Музыку».')
  assert.equal(musicReply({ action: 'now' }, { code: 'nothing-playing' }), 'Сейчас ничего не играет.')
  assert.equal(
    musicReply({ action: 'search', query: 'земфиры', kind: 'artist', play: false }, { code: 'ok', found: { title: 'Хочешь?', artist: 'Земфира' } }),
    'Нашёл: «Хочешь?», Земфира. Включить?',
  )
  assert.equal(musicReply({ action: 'search', query: 'абв', kind: 'any', play: true }, { code: 'not-found' }), 'По запросу «абв» ничего не нашёл.')
  assert.equal(musicReply({ action: 'volume', delta: 1 }, { code: 'ok', volume: 45 }), 'Громкость 45 процентов.')
  assert.equal(musicReply({ action: 'clarify', kind: 'track', play: true }, { code: 'ok' }), 'Какую песню включить?')
})

test('what is playing: never "nothing" without grounds', () => {
  const now = { action: 'now' } as const
  assert.equal(musicReply(now, { code: 'ok', playing: true, title: null }), 'Музыка играет, но название трека определить не удалось.')
  assert.equal(musicReply(now, { code: 'ok', playing: false, title: 'Хочешь?', artist: 'Земфира' }), 'На паузе: «Хочешь?», Земфира.')
  assert.equal(musicReply(now, { code: 'ok', playing: false }), 'Музыка на паузе.')
  assert.equal(musicReply(now, { code: 'unknown' }), 'Не удалось определить состояние воспроизведения.')
  assert.equal(musicReply(now, { code: 'idle' }), 'Яндекс Музыка открыта, но воспроизведение в ней не запущено.')
  assert.equal(
    musicReply(now, { code: 'ok', playing: true, title: 'Мне похуй', artist: 'DJ Bulava', source: 'Яндекс Браузер' }),
    'Сейчас играет «Мне похуй», DJ Bulava (Яндекс Браузер).',
  )
})

test('playlist replies', () => {
  const liked = { action: 'playlist', liked: true, play: true } as const
  assert.equal(
    musicReply(liked, { code: 'ok', playing: true, playlist: 'Мне нравится', title: 'Мне похуй', artist: 'DJ Bulava' }),
    'Включаю плейлист «Мне нравится»: «Мне похуй», DJ Bulava.',
  )
  assert.equal(musicReply(liked, { code: 'unconfirmed' }), 'Плейлист нашёл, но воспроизведение не началось.')
  assert.equal(
    musicReply({ action: 'playlist', name: 'понравилось на радио', play: true }, { code: 'empty', playlist: 'Понравилось на Радио' }),
    'Плейлист «Понравилось на Радио» пуст — включать нечего.',
  )
  assert.equal(musicReply(liked, { code: 'not-found' }), 'Не нашёл плейлист «Мне нравится» в вашей коллекции.')
  const road = { action: 'playlist', name: 'дорога', play: true } as const
  assert.equal(musicReply(road, { code: 'not-found', playlists: ['Распознано', 'Мне нравится'] }), 'У вас нет плейлиста «дорога». Ваши плейлисты: Распознано, Мне нравится.')
  assert.equal(musicReply(road, { code: 'ambiguous', options: ['Дорога', 'Дорога домой'] }), 'Нашёл несколько плейлистов: Дорога, Дорога домой. Какой включить?')
  assert.equal(musicReply({ action: 'playlist', name: 'дорога', play: false }, { code: 'ok', playlist: 'Дорога' }), 'Нашёл ваш плейлист «Дорога». Включить?')
})
