// itd.claim (ITGAME-151): чистая логика src/debug/claimCore.ts — без Phaser и DOM, Node берёт .ts как есть.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAIM_KEY, GROUP_MS, PRESS_CAP, addPress, checkAllow, checkLabel, checkMine, closeAllow, joinsGroup, newRecord,
  normTarget, openAllow, parseRecord, serialize, setMine, stateOf,
} from '../../src/debug/claimCore.ts'

const T0 = 1_000_000
const tap = (rec, at, onCanvas = true) => addPress(rec, at, { button: 0, onCanvas })

test('addPress: без mine и allow — foreign; n и t от claim()', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  const p = tap(rec, T0 + 1234)
  assert.equal(p.kind, 'foreign')
  assert.equal(p.n, 1)
  assert.equal(p.t, 1.2)
  assert.equal(p.wins, null)
  assert.deepEqual(p.got, [])
  assert.deepEqual([rec.own, rec.allowed, rec.foreign, rec.onCanvas], [0, 0, 1, 1])
  tap(rec, T0 + 2000, false)
  assert.deepEqual([rec.foreign, rec.onCanvas], [2, 1])
})

test('mine: бюджет на n нажатий — own, mine важнее allow, потом allowed', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  setMine(rec, 2, 20_000, T0)
  openAllow(rec, 'нажми', undefined, T0)
  assert.deepEqual([tap(rec, T0 + 10).kind, tap(rec, T0 + 20).kind, tap(rec, T0 + 30).kind], ['own', 'own', 'allowed'])
  assert.equal(rec.mine, null)
  assert.deepEqual([rec.own, rec.allowed, rec.foreign], [2, 1, 0])
})

test('mine истекает по времени — нажатие снова foreign', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  setMine(rec, 1, 200, T0)
  assert.equal(tap(rec, T0 + 400).kind, 'foreign')
  assert.equal(rec.mine, null)
})

test('allow/deny: target в safe-форме, hit по got разрешённого нажатия этого окна', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  openAllow(rec, 'нажми «НОРМА»', 'menu.diff.normal', T0 + 1000)
  assert.equal(rec.allow.target, 'menu:diff:normal')
  assert.equal(rec.allow.since, 1)
  assert.equal(stateOf(rec, T0 + 1000, true).allow.hit, false)
  const p = tap(rec, T0 + 1100)
  p.got.push('menu:diff:normal')
  assert.equal(stateOf(rec, T0 + 1200, true).allow.hit, true)
  const res = closeAllow(rec)
  assert.equal(res.ok, true)
  assert.equal(res.hit, true)
  assert.equal(res.what, 'нажми «НОРМА»')
  assert.equal(res.presses.length, 1)
  assert.equal(rec.allow, null)
  const again = closeAllow(rec)
  assert.equal(again.ok, false)
  assert.equal(again.code, 'no_allow')
})

test('allow: новое окно не берёт нажатия прошлого; без target hit — null', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  openAllow(rec, 'a', 'btn.x', T0)
  tap(rec, T0 + 10).got.push('btn:x')
  openAllow(rec, 'b', 'btn.x', T0 + 500)
  assert.equal(stateOf(rec, T0 + 600, true).allow.hit, false)
  assert.deepEqual(closeAllow(rec).presses, [])
  openAllow(rec, 'c', undefined, T0 + 700)
  tap(rec, T0 + 800)
  const res = closeAllow(rec)
  assert.equal(res.hit, null)
  assert.equal(res.target, null)
  assert.equal(res.presses.length, 1)
})

test('presses: хранятся последние PRESS_CAP, n растёт дальше', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  for (let i = 0; i < PRESS_CAP + 10; i++) tap(rec, T0 + i * 100)
  assert.equal(rec.presses.length, PRESS_CAP)
  assert.equal(rec.presses[0].n, 11)
  assert.equal(stateOf(rec, T0 + 10_000, true).downs, PRESS_CAP + 10)
})

test('joinsGroup: события в пределах GROUP_MS от первого — одно нажатие', () => {
  assert.equal(joinsGroup(null, 0), false)
  assert.equal(joinsGroup(100, 100 + GROUP_MS - 1), true)
  assert.equal(joinsGroup(100, 100 + GROUP_MS), false)
  assert.equal(joinsGroup(100, 160), false)
})

test('проверки аргументов: метка, mine, allow', () => {
  assert.equal(checkLabel('qa151'), null)
  for (const bad of ['', '   ', 'x'.repeat(41), 5, undefined]) assert.equal(checkLabel(bad)?.code, 'bad_label', String(bad))
  assert.equal(checkMine(1, 20_000), null)
  assert.equal(checkMine(20, 100), null)
  assert.equal(checkMine(1, 120_000), null)
  for (const [n, ms] of [[0, 1000], [21, 1000], [1.5, 1000], [1, 99], [1, 120_001], [1, 1000.5], ['1', 1000]]) {
    assert.equal(checkMine(n, ms)?.code, 'bad_args', `${n}/${ms}`)
  }
  assert.equal(checkAllow('нажми', undefined), null)
  assert.equal(checkAllow('нажми', 'btn.hire'), null)
  for (const [what, target] of [['', undefined], ['  ', undefined], ['x'.repeat(81), undefined], ['нажми', ''], ['нажми', 7], [3, undefined]]) {
    assert.equal(checkAllow(what, target)?.code, 'bad_args', `${what}/${target}`)
  }
})

test('normTarget: точки → двоеточия, safe-форма не меняется', () => {
  assert.equal(normTarget('menu.diff.normal'), 'menu:diff:normal')
  assert.equal(normTarget('btn:hire'), 'btn:hire')
})

test('stateOf: sec, downs, mine с leftMs; presses — копия', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  tap(rec, T0 + 100)
  setMine(rec, 1, 1000, T0 + 2000)
  const s = stateOf(rec, T0 + 2400, true)
  assert.equal(s.ok, true)
  assert.equal(s.active, true)
  assert.equal(s.sec, 2)
  assert.equal(s.downs, 1)
  assert.deepEqual(s.mine, { pending: 1, leftMs: 600 })
  s.presses[0].got.push('z')
  assert.deepEqual(rec.presses[0].got, [])
  assert.equal(stateOf(rec, T0 + 3500, false).mine, null)
  assert.equal(stateOf(rec, T0 + 3500, false).active, false)
})

test('serialize/parseRecord: круг без потерь, мусор — null', () => {
  const rec = newRecord('qa', 'abc1234', T0)
  setMine(rec, 2, 5000, T0)
  openAllow(rec, 'нажми', 'btn.hire', T0)
  tap(rec, T0 + 10).got.push('btn:hire')
  assert.deepEqual(parseRecord(serialize(rec)), rec)
  assert.equal(parseRecord(null), null)
  assert.equal(parseRecord('{'), null)
  assert.equal(parseRecord('{"label":1}'), null)
  assert.equal(parseRecord('null'), null)
  assert.equal(CLAIM_KEY, 'itd.claim')
})
