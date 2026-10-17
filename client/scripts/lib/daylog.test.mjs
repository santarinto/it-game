// Лента HUD по журналу дня (ITGAME-163): строки state.dayLog приходят вживую и
// кладутся в ленту со своим «HH:MM», вечерний отчёт добавляет только то, чего
// лента ещё не видела; на переходе дня — «Утро, день N» с часами начала дня.
// src/eventlog.ts без Phaser, импорт только type — Node берёт его как есть.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newDayLine, parseLogLine, takeDayLog } from '../../src/eventlog.ts'

test('parseLogLine: своё «HH:MM» строки журнала сервера отделяется от текста', () => {
  assert.deepEqual(parseLogLine('10:50 вирус в офисе 1: 2 ПК'), { clock: '10:50', text: 'вирус в офисе 1: 2 ПК' })
  assert.deepEqual(parseLogLine('дедлайн проигнорирован'), { clock: null, text: 'дедлайн проигнорирован' })
})

test('takeDayLog: журнал дня растёт — в ленту идёт только хвост после уже положенного', () => {
  let cur = { key: '', shown: 0 }
  let r = takeDayLog(cur, '7:4', ['10:50 вирус в офисе 1: 2 ПК', '11:00 вирус в офисе 1: чистим вручную'])
  assert.deepEqual(r.lines.map((l) => l.clock + ' ' + l.text), ['10:50 вирус в офисе 1: 2 ПК', '11:00 вирус в офисе 1: чистим вручную'])
  assert.deepEqual(r.cursor, { key: '7:4', shown: 2 })
  cur = r.cursor
  r = takeDayLog(cur, '7:4', ['10:50 вирус в офисе 1: 2 ПК', '11:00 вирус в офисе 1: чистим вручную', '15:20 вирус: офис 1 вычищен вручную к 15:20'])
  assert.deepEqual(r.lines, [{ clock: '15:20', text: 'вирус: офис 1 вычищен вручную к 15:20' }])
  cur = r.cursor
  // Тот же журнал ещё раз (снапшот без событий, пересланный отчёт) — ничего.
  r = takeDayLog(cur, '7:4', ['10:50 вирус в офисе 1: 2 ПК', '11:00 вирус в офисе 1: чистим вручную', '15:20 вирус: офис 1 вычищен вручную к 15:20'])
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.cursor, { key: '7:4', shown: 3 })
})

test('takeDayLog: другой день или партия — журнал с начала', () => {
  const r = takeDayLog({ key: '7:4', shown: 3 }, '7:5', ['12:10 дедлайн принят: цель $5000'])
  assert.deepEqual(r.lines, [{ clock: '12:10', text: 'дедлайн принят: цель $5000' }])
  assert.deepEqual(r.cursor, { key: '7:5', shown: 1 })
  assert.deepEqual(takeDayLog({ key: '7:5', shown: 1 }, '9:1', []), { lines: [], cursor: { key: '9:1', shown: 0 } })
})

test('takeDayLog: журнал того же дня стал короче (restore) — без повторов', () => {
  const r = takeDayLog({ key: '7:4', shown: 3 }, '7:4', ['10:50 вирус в офисе 1: 2 ПК'])
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.cursor, { key: '7:4', shown: 1 })
})

const st = (o) => ({ seed: '7', day: 4, clock: '18:20', tickInDay: 50, ticksPerHour: 6, ...o })

test('newDayLine: день той же партии сменился — «Утро, день N» с часами начала дня', () => {
  assert.deepEqual(newDayLine(st({}), st({ day: 5, clock: '10:00', tickInDay: 0 })), { clock: '10:00', text: 'Утро, день 5' })
  // Вкладка увидела новый день не с первого тика — часы всё равно начала дня.
  assert.deepEqual(newDayLine(st({}), st({ day: 5, clock: '10:20', tickInDay: 2 })), { clock: '10:00', text: 'Утро, день 5' })
  // Офлайн на несколько дней — одна строка на итоговый день.
  assert.deepEqual(newDayLine(st({}), st({ day: 8, clock: '10:00', tickInDay: 0 })), { clock: '10:00', text: 'Утро, день 8' })
})

test('newDayLine: первый снапшот, тот же день, другая партия, день назад — строки нет', () => {
  assert.equal(newDayLine(null, st({ day: 1, clock: '10:00', tickInDay: 0 })), null)
  assert.equal(newDayLine(st({}), st({ clock: '18:30', tickInDay: 51 })), null)
  assert.equal(newDayLine(st({}), st({ seed: '8', day: 5, clock: '10:00', tickInDay: 0 })), null)
  assert.equal(newDayLine(st({ day: 6 }), st({ day: 5, clock: '10:00', tickInDay: 0 })), null)
})
