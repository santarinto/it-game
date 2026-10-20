// Чит для localhost (ITGAME-194): window.cheat ставится только на локальном хосте.
// src/debug/localhost.ts без импортов — Node берёт его как есть.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalHostname } from '../../src/debug/localhost.ts'

test('isLocalHostname: localhost, 127.0.0.1, [::1], *.localhost — да', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', 'itgame.localhost', 'LOCALHOST']) {
    assert.equal(isLocalHostname(h), true, h)
  }
})

test('isLocalHostname: прод, стейдж и похожие имена — нет', () => {
  for (const h of ['itgame.santarinto.ru', 'stage.itgame.santarinto.ru', 'localhost.evil.com', '127.0.0.2', '10.8.1.5', '']) {
    assert.equal(isLocalHostname(h), false, h)
  }
})
