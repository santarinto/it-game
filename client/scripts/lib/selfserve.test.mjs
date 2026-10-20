// node --test: окружение self-serve сервера (ITGAME-182) — токен координатора minipc не
// уходит никогда, унаследованный DATABASE_URL не уходит, явно переданный — уходит.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serverEnv } from './selfserve.mjs'

test('serverEnv: без ITGAME_MINIPC_CLI_TOKEN и унаследованного DATABASE_URL, с ITGAME_DEBUG=1', () => {
  const env = serverEnv({ PATH: '/bin', ITGAME_MINIPC_URL: 'u', ITGAME_MINIPC_TOKEN: 'go', ITGAME_MINIPC_CLI_TOKEN: 'cli', DATABASE_URL: 'postgres:///stand' })
  assert.deepEqual(env, { PATH: '/bin', ITGAME_MINIPC_URL: 'u', ITGAME_MINIPC_TOKEN: 'go', ITGAME_DEBUG: '1' })
})

test('serverEnv: DATABASE_URL — только переданный явно; токен координатора не проходит и так', () => {
  const env = serverEnv({ DATABASE_URL: 'postgres:///stand' }, { DATABASE_URL: 'postgres:///qa', ITGAME_MINIPC_CLI_TOKEN: 'cli' })
  assert.equal(env.DATABASE_URL, 'postgres:///qa')
  assert.equal('ITGAME_MINIPC_CLI_TOKEN' in env, false)
  assert.equal(serverEnv({}, { ITGAME_DEBUG: '0' }).ITGAME_DEBUG, '1')
})
