// qa-itgame39 — машинный контракт itd.contract() (ITGAME-39):
//   A1  schema === 1
//   A2  version.hash — 12 hex-символов; version.sha/builtAt === itd.version
//   A3  Object.keys(contract().methods) (сортированные) === Object.keys(window.itd)
//       (сортированные) — контракт описывает РОВНО факасад, без дублей/пропусков
//   A4  у каждого метода в contract().methods — непустой doc
//   A5  types содержит AgentNode, CmdReceipt, AgentServer, ServerErrorCode,
//       TransportErrorCode, SocketStatus
//   A6  types.ServerErrorCode — enum, значения включают equipment_already
//   A7  contract() — новый объект при каждом вызове (structuredClone):
//       мутация результата не протекает во второй вызов
//   A8  hash стабилен между двумя вызовами contract() в одной сессии
//   A9  types.SocketStatus — enum [closed, open, reconnecting]; itd.server().socket ∈ values
//   A10 types.TransportErrorCode.values === [disconnected, not_connected, receipt_timeout]
//   A11 (ITGAME-87/88/91) новые поля в контракте: TraceApi — call (action, windowMs) + start/stop,
//       methods.trace — prop с примерами; TraceResult.pointer, TracePointer; AgentNode.fill;
//       StaleInfo.shown; AgentOffline.seq/awayId; AwayResult.awayId; JournalRecord.conn/src;
//       JournalView.lines расшифровывает end (evicted/read_timeout/debug_drop/disconnect);
//       SandboxApi тоже с call; itd.trace.start/stop — функции
//   A16 (ITGAME-179/148/160) трасса 20.10: TracePointer.wins — string | null, sent — TraceSent[] с src и doc, TraceApi.summary → TraceSummary.lines; itd.trace.summary — функция;
//       TracePointer.gone, screen → bad_frame, ScreenMap.ok (ITGAME-148), TraceApi.peek (ITGAME-160)
//   A17 (ITGAME-151) itd.claim: ClaimApi — call (label) + mine/allow/deny/state/stop, methods.claim — prop
//       ClaimApi с примерами; ClaimPress n/t/kind/button/onCanvas/wins/got; itd.claim.* — функции
//   A12 (ITGAME-131) из меню (liveSid null, socket closed): set/step/advanceDays/ledger/scenario/
//       snapshot/restore → reject «not_in_party: …» с подсказкой itd.click('menu.diff.normal'),
//       play([{days:1}]) → «FAIL not_in_party»; ни одного запроса /api/debug/*
//   A13 itd.journal() из меню без гарда: ушёл ровно GET /api/debug/journal, отказ сервера no_journal
//   A14 menu.diff.normal → liveSid = sid вкладки сразу (сокет ещё открывается); после
//       wait(connected) snapshot()/scenario('fresh') проходят под ним — 2 запроса /api/debug/state
//   A15 «Сохранить и выйти» → меню: liveSid null, snapshot() снова not_in_party без запроса;
//       itd.journal() отдаёт журнал ушедшей партии (sid вкладки, total ≥ 1)
//   A18 (ITGAME-155) itd.errors({since}) на своей вкладке (тестовые ошибки — не pageerror прогона): ошибка
//       загрузки 1, F5, ошибка загрузки 2 → без аргумента обе; since: server().load — только загрузки 2;
//       since: метка времени между ними — только вторая; since в будущем — []; {} — как без аргумента;
//       since -1 / 1.5 / NaN / строка → {ok:false, code:'bad_since'}; контракт: errors(opts?: ErrorsOptions),
//       AgentServer.load
//   A19 (ITGAME-166) itd.exit() — «Сохранить и выйти» одним вызовом: из меню → not_in_party без кадра exit;
//       во время itd.away (сокет не открыт) → not_connected, вкладка в партии, окна «Нет связи» нет; в партии
//       на 2x → {ok:true, menuReady:true}, hud/office не активны, меню активно, сокет closed, liveSid null,
//       в журнале партии — exit =2 от вкладки (тот же кадр, что у кнопки); контракт: ExitResult
//   + на странице нет pageerror
//
// Self-serve: без QA_BASE поднимает Go-сервер на QA_PORT (по умолчанию
// :4178 — свой порт задачи; 4179 у qa:tabs, 4173–4177 у соседних скриптов).
import { selfServe } from './lib/selfserve.mjs'
import { waitMenuReady } from './lib/menu.mjs'
import puppeteer from 'puppeteer-core'
import { chromePath } from './lib/chrome.mjs'

const SELF_PORT = Number(process.env.QA_PORT) || 4178

const BASE = process.env.QA_BASE || `http://127.0.0.1:${SELF_PORT}`

const results = []
function check(name, pass, fact) {
  results.push({ name, pass, fact })
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${fact ? ` — ${fact}` : ''}`)
}

// Готовность меню — waitMenuReady (lib/menu.mjs): sid выставлен до документа, меню ждёт
// сводку сейва, и ранний клик открывал «Начать заново?» (ITGAME-130; A14 ITGAME-131 стартует партию из меню).

async function run() {
  let stopServer = null
  if (!process.env.QA_BASE) {
    try {
      ;({ stop: stopServer } = await selfServe({ port: SELF_PORT, saves: 'off', label: 'QA-ITGAME39' }))
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }

  const pageErrors = []
  // launch внутри try: упавший Chromium не должен оставлять bin/itdirector на порту
  let browser = null
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    // ITGAME-131: запросы к /api/debug/* — гард not_in_party не должен их слать
    const debugReqs = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.pathname.startsWith('/api/debug/')) debugReqs.push(`${r.method()} ${u.pathname}`)
    })
    await page.setViewport({ width: 1920, height: 1080 })

    const sid = 'qa39-' + Date.now().toString(36)
    await page.evaluateOnNewDocument((sid) => {
      try {
        sessionStorage.setItem('itd.sid', sid)
      } catch {
        // приватная вкладка/заблокированное хранилище — не критично для QA
      }
    }, sid)

    await page.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(page)

    const data = await page.evaluate(() => {
      const c1 = window.itd.contract()
      const c2 = window.itd.contract()
      // Мутация первого результата не должна протечь во второй вызов
      // (contract() — structuredClone, не общая ссылка на кэш модуля).
      c1.methods.state.doc = 'МУТИРОВАНО'
      const c3 = window.itd.contract()
      return {
        c1: JSON.parse(JSON.stringify(c1)),
        c2Hash: c2.version.hash,
        c3StateDoc: c3.methods.state.doc,
        itdKeys: Object.keys(window.itd),
        itdVersion: window.itd.version,
        socketNow: window.itd.server().socket,
        itdTraceFns: [typeof window.itd.trace, typeof window.itd.trace.start, typeof window.itd.trace.stop].join(),
        itdTraceMore: [typeof window.itd.trace.summary, typeof window.itd.trace.peek].join(),
        itdClaimFns: [typeof window.itd.claim, ...['mine', 'allow', 'deny', 'state', 'stop'].map((k) => typeof window.itd.claim[k])].join(),
      }
    })
    const { c1: contract, c2Hash, c3StateDoc, itdKeys, itdVersion, socketNow, itdTraceFns, itdTraceMore, itdClaimFns } = data

    // ── A1: schema
    check('A1: schema === 1', contract.schema === 1, `schema=${contract.schema}`)

    // ── A2: version.hash формат + sha/builtAt совпадают с itd.version
    check(
      'A2: version.hash — 12 hex-символов',
      typeof contract.version.hash === 'string' && /^[0-9a-f]{12}$/.test(contract.version.hash),
      `hash=${contract.version.hash}`,
    )
    check(
      'A2: version.sha/builtAt === itd.version',
      contract.version.sha === itdVersion.sha && contract.version.builtAt === itdVersion.builtAt,
      JSON.stringify({ contract: { sha: contract.version.sha, builtAt: contract.version.builtAt }, itd: itdVersion }),
    )

    // ── A3: методы контракта === реальные ключи window.itd (без дублей/пропусков)
    const methodKeys = Object.keys(contract.methods).sort()
    const realKeys = itdKeys.sort()
    check(
      'A3: Object.keys(contract().methods) === Object.keys(window.itd)',
      JSON.stringify(methodKeys) === JSON.stringify(realKeys),
      `methods=${methodKeys.length} itd=${realKeys.length}` +
        (JSON.stringify(methodKeys) === JSON.stringify(realKeys)
          ? ''
          : ` diff=${JSON.stringify({ onlyContract: methodKeys.filter((k) => !realKeys.includes(k)), onlyItd: realKeys.filter((k) => !methodKeys.includes(k)) })}`),
    )

    // ── A4: у каждого метода — непустой doc
    const emptyDocs = Object.entries(contract.methods)
      .filter(([, spec]) => !spec.doc || spec.doc.trim().length === 0)
      .map(([name]) => name)
    check('A4: у каждого метода contract().methods — непустой doc', emptyDocs.length === 0, JSON.stringify(emptyDocs))

    // ── A5: обязательные типы присутствуют
    const requiredTypes = ['AgentNode', 'CmdReceipt', 'AgentServer', 'ServerErrorCode', 'TransportErrorCode', 'SocketStatus']
    const missingTypes = requiredTypes.filter((t) => !(t in contract.types))
    check('A5: types содержит AgentNode/CmdReceipt/AgentServer/ServerErrorCode/TransportErrorCode/SocketStatus', missingTypes.length === 0, JSON.stringify(missingTypes))

    // ── A6: ServerErrorCode — enum с equipment_already
    const sec = contract.types.ServerErrorCode
    check(
      'A6: types.ServerErrorCode — enum, значения включают equipment_already',
      sec?.kind === 'enum' && Array.isArray(sec.values) && sec.values.includes('equipment_already'),
      JSON.stringify(sec),
    )

    // ── A7: мутация результата contract() не протекает в следующий вызов
    check(
      'A7: contract() — новый объект при каждом вызове (мутация не протекает)',
      c3StateDoc !== 'МУТИРОВАНО' && typeof c3StateDoc === 'string' && c3StateDoc.length > 0,
      `c3StateDoc=${JSON.stringify(c3StateDoc)}`,
    )

    // ── A8: hash стабилен между вызовами в одной сессии
    check('A8: hash стабилен между вызовами contract()', contract.version.hash === c2Hash, `${contract.version.hash} vs ${c2Hash}`)

    // ── A9: SocketStatus — enum, текущий статус сокета ∈ values
    const ss = contract.types.SocketStatus
    check(
      'A9: types.SocketStatus — enum [closed, open, reconnecting], itd.server().socket ∈ values',
      ss?.kind === 'enum' &&
        JSON.stringify(ss.values) === JSON.stringify(['closed', 'open', 'reconnecting']) &&
        ss.values.includes(socketNow),
      JSON.stringify({ ss, socketNow }),
    )

    // ── A10: TransportErrorCode — enum из трёх транспортных кодов
    const tec = contract.types.TransportErrorCode
    check(
      'A10: types.TransportErrorCode.values === [disconnected, not_connected, receipt_timeout]',
      JSON.stringify(tec?.values) === JSON.stringify(['disconnected', 'not_connected', 'receipt_timeout']),
      JSON.stringify(tec),
    )

    // ── A11: поля волны 10.10-b
    const T = contract.types
    const has = (t, f) => !!T[t]?.fields?.[f]
    const linesDoc = T.JournalView?.fields?.lines?.doc ?? ''
    const a11 = {
      traceCall: T.TraceApi?.call,
      traceFields: Object.keys(T.TraceApi?.fields ?? {}),
      traceMember: contract.methods.trace && { kind: contract.methods.trace.kind, type: contract.methods.trace.type, ex: contract.methods.trace.examples },
      sandboxCall: T.SandboxApi?.call,
      fields: {
        pointer: has('TraceResult', 'pointer'), wins: has('TracePointer', 'wins'), got: has('TracePointer', 'got'),
        fill: has('AgentNode', 'fill'), shown: has('StaleInfo', 'shown'), seq: has('AgentOffline', 'seq'),
        offAway: has('AgentOffline', 'awayId'), awayId: has('AwayResult', 'awayId'), conn: has('JournalRecord', 'conn'), src: has('JournalRecord', 'src'),
      },
      endDoc: ['evicted', 'read_timeout', 'debug_drop', 'disconnect'].every((w) => linesDoc.includes(w)),
      fns: itdTraceFns,
    }
    check(
      'A11: контракт волны 10.10-b — TraceApi call+start/stop, pointer/fill/shown/seq/awayId/conn/src, end расшифрован',
      JSON.stringify(a11.traceCall) === JSON.stringify(['(action: () => unknown, windowMs?: number) => Promise<TraceResult>']) &&
        a11.traceFields.includes('start') && a11.traceFields.includes('stop') &&
        a11.traceMember?.kind === 'prop' && a11.traceMember.type === 'TraceApi' && (a11.traceMember.ex ?? []).length >= 2 &&
        Array.isArray(a11.sandboxCall) && a11.sandboxCall.length === 1 &&
        Object.values(a11.fields).every(Boolean) && a11.endDoc && a11.fns === 'function,function,function',
      JSON.stringify(a11),
    )

    // ── A16 (ITGAME-179/148/160): трасса волны 20.10 в контракте
    const a16 = {
      wins: T.TracePointer?.fields?.wins?.type,
      sent: T.TraceResult?.fields?.sent?.type,
      src: T.TraceSent?.fields?.src,
      summary: T.TraceApi?.fields?.summary,
      lines: T.TraceSummary?.fields?.lines,
      fns: itdTraceMore,
      gone: T.TracePointer?.fields?.gone?.type,
      peek: T.TraceApi?.fields?.peek,
      screenRet: contract.methods.screen?.returns,
      screenOk: T.ScreenMap?.fields?.ok?.type,
    }
    check(
      'A16: контракт трассы 20.10 — wins метка (string | null), sent: TraceSent[] с src itd|ui и doc, TraceApi.summary → TraceSummary.lines (ITGAME-179); TracePointer.gone, screen → bad_frame, ScreenMap.ok (ITGAME-148); TraceApi.peek (ITGAME-160)',
      a16.wins === 'string | null' && a16.sent === 'TraceSent[]' &&
        a16.src?.type === "'itd' | 'ui'" && !!a16.src.doc &&
        !!a16.summary?.doc && a16.summary.type.includes('TraceSummary') &&
        a16.lines?.type === 'string[]' && !!a16.lines.doc && a16.fns === 'function,function' &&
        !!a16.peek?.doc && a16.peek.type.includes("'no_trace'") &&
        a16.gone === 'string[]' && (a16.screenRet ?? '').includes("'bad_frame'") && a16.screenOk === 'true',
      JSON.stringify(a16),
    )

    // ── A17 (ITGAME-151): itd.claim в контракте
    const a17 = {
      call: T.ClaimApi?.call,
      fields: Object.keys(T.ClaimApi?.fields ?? {}),
      member: contract.methods.claim && { kind: contract.methods.claim.kind, type: contract.methods.claim.type, ex: contract.methods.claim.examples },
      press: Object.keys(T.ClaimPress?.fields ?? {}),
      fns: itdClaimFns,
    }
    check(
      'A17: контракт itd.claim — ClaimApi call (label) + mine/allow/deny/state/stop, prop с примерами, ClaimPress n/t/kind/button/onCanvas/wins/got, itd.claim.* — функции',
      JSON.stringify(a17.call) === JSON.stringify(['(label: string) => ClaimState | ClaimRefusal']) &&
        ['mine', 'allow', 'deny', 'state', 'stop'].every((f) => a17.fields.includes(f)) &&
        a17.member?.kind === 'prop' && a17.member.type === 'ClaimApi' && (a17.member.ex ?? []).length >= 2 &&
        ['n', 't', 'kind', 'button', 'onCanvas', 'wins', 'got'].every((f) => a17.press.includes(f)) &&
        a17.fns === 'function,function,function,function,function,function',
      JSON.stringify(a17),
    )

    // ── A12 (ITGAME-131): из меню debug-вызовы отказывают на клиенте, без запроса
    const reqsA12 = debugReqs.length
    const a12 = await page.evaluate(async () => {
      const itd = window.itd
      const msg = (p) => p.then(() => 'resolved', (e) => String(e?.message ?? e))
      return {
        liveSid: itd.server().liveSid,
        socket: itd.server().socket,
        calls: {
          set: await msg(itd.set({ money: 1 })),
          step: await msg(itd.step({ ticks: 1 })),
          advanceDays: await msg(itd.advanceDays(1)),
          ledger: await msg(itd.ledger()),
          scenario: await msg(itd.scenario('fresh')),
          snapshot: await msg(itd.snapshot()),
          restore: await msg(itd.restore({})),
        },
        play: await itd.play([{ days: 1 }]),
      }
    })
    const a12Reqs = debugReqs.slice(reqsA12)
    check(
      'A12: из меню (liveSid null) set/step/advanceDays/ledger/scenario/snapshot/restore → reject not_in_party с подсказкой menu.diff.normal, play {days} → FAIL not_in_party; ни одного запроса /api/debug/* (ITGAME-131)',
      a12.liveSid === null && a12.socket === 'closed' &&
        Object.values(a12.calls).every((m) => m.startsWith('not_in_party: ') && m.includes("itd.click('menu.diff.normal')")) &&
        a12.play.length === 1 && a12.play[0].includes('FAIL not_in_party') &&
        a12Reqs.length === 0,
      JSON.stringify({ ...a12, reqs: a12Reqs }),
    )

    // ── A13: itd.journal() не под гардом — запрос уходит, отказ серверный (партии с этим sid ещё не было)
    const reqsA13 = debugReqs.length
    const a13 = await page.evaluate(() =>
      window.itd.journal({ tail: 1 }).then(() => 'resolved', (e) => String(e?.message ?? e)),
    )
    const a13Reqs = debugReqs.slice(reqsA13)
    check(
      'A13: itd.journal() из меню — без гарда: ушёл GET /api/debug/journal, ответ no_journal (ITGAME-131)',
      a13.startsWith('no_journal') && a13Reqs.length === 1 && a13Reqs[0] === 'GET /api/debug/journal',
      JSON.stringify({ a13, reqs: a13Reqs }),
    )

    // ── A14: после клика по сложности те же вызовы идут в партию вкладки
    const reqsA14 = debugReqs.length
    const a14 = await page.evaluate(async () => {
      const itd = window.itd
      await itd.wait((s) => s.menuReady === true, 10000) // сводка сейва устоялась: клик не спросит «Начать заново?»
      const click = itd.click('menu.diff.normal')
      const liveAtClick = itd.server().liveSid // connect() ставит его синхронно — сокет ещё открывается
      await itd.wait((s) => s.connected === true, 10000)
      const snap = await itd.snapshot()
      const sc = await itd.scenario('fresh')
      return { click: click.ok, liveAtClick, liveSid: itd.server().liveSid, snapSid: snap.sid, scSid: sc.sid, scenario: sc.state.scenario }
    })
    const a14Reqs = debugReqs.slice(reqsA14)
    check(
      'A14: menu.diff.normal → liveSid сразу = sid вкладки; после wait(connected) snapshot()/scenario("fresh") проходят под ним, 2 запроса /api/debug/state (ITGAME-131)',
      a14.click && a14.liveAtClick === sid && a14.liveSid === sid && a14.snapSid === sid && a14.scSid === sid &&
        a14.scenario === 'fresh' && a14Reqs.length === 2 && a14Reqs.every((r) => r.endsWith(' /api/debug/state')),
      JSON.stringify({ ...a14, reqs: a14Reqs }),
    )

    // ── A15: «Сохранить и выйти» → меню: liveSid снова null, отказ без запроса; журнал ушедшей партии читается
    await page.evaluate(async () => {
      const itd = window.itd
      await itd.wait(() => itd.ids().some((n) => n.id === 'btn.menu'), 10000)
      itd.click('btn.menu')
      itd.click('modal.btn.0') // «Сохранить и выйти»
      await itd.wait((s) => s.menuReady === true, 15000)
    })
    const reqsA15 = debugReqs.length
    const a15 = await page.evaluate(async () => ({
      liveSid: window.itd.server().liveSid,
      snapshot: await window.itd.snapshot().then(() => 'resolved', (e) => String(e?.message ?? e)),
    }))
    const a15Reqs = debugReqs.slice(reqsA15)
    const a15j = await page.evaluate(() =>
      window.itd.journal({ tail: 1 }).then((j) => ({ sid: j.sid, total: j.total }), (e) => ({ error: String(e?.message ?? e) })),
    )
    check(
      'A15: «Сохранить и выйти» → liveSid null, snapshot() — not_in_party без запроса; itd.journal() отдаёт журнал ушедшей партии (ITGAME-131)',
      a15.liveSid === null && a15.snapshot.startsWith('not_in_party: ') && a15Reqs.length === 0 && a15j.sid === sid && a15j.total >= 1,
      JSON.stringify({ ...a15, reqs: a15Reqs, journal: a15j }),
    )

    // ── A18 (ITGAME-155): itd.errors({since}) — фильтр журнала по времени или номеру загрузки.
    // Своя вкладка: тестовые ошибки itd.injectError не должны попасть в pageerror прогона.
    const pe = await browser.newPage()
    await pe.setViewport({ width: 1920, height: 1080 })
    const sidE = 'qa39e-' + Date.now().toString(36)
    await pe.evaluateOnNewDocument((sid) => {
      try {
        sessionStorage.setItem('itd.sid', sid)
      } catch {
        // приватная вкладка/заблокированное хранилище — не критично для QA
      }
    }, sidE)
    await pe.goto(`${BASE}/?scenario=fresh&seed=1&debug=1`, { waitUntil: 'domcontentloaded' })
    await waitMenuReady(pe)
    const e1 = await pe.evaluate(async () => {
      window.itd.injectError('qa39-load-a')
      await new Promise((r) => setTimeout(r, 100))
      return { load: window.itd.server().load, mid: Date.now() + 1 }
    })
    await new Promise((r) => setTimeout(r, 20))
    await pe.reload({ waitUntil: 'domcontentloaded' })
    await waitMenuReady(pe)
    const a18 = await pe.evaluate(async (mid) => {
      const itd = window.itd
      itd.injectError('qa39-load-b')
      await new Promise((r) => setTimeout(r, 100))
      const ours = (list) => (Array.isArray(list) ? list.filter((e) => e.message.includes('qa39-load-')).map((e) => `${e.message.replace(/^.*qa39-load-/, '')}@${e.load}`) : list)
      const load = itd.server().load
      return {
        load,
        all: ours(itd.errors()),
        empty: ours(itd.errors({})),
        byLoad: ours(itd.errors({ since: load })),
        byTime: ours(itd.errors({ since: mid })),
        future: itd.errors({ since: Date.now() + 3600000 }),
        bad: [-1, 1.5, NaN, 'x'].map((v) => { const r = itd.errors({ since: v }); return Array.isArray(r) ? 'массив' : r.code }),
      }
    }, e1.mid)
    const a18c = contract.methods.errors
    check(
      'A18: itd.errors({since}) — без аргумента и с {} обе загрузки; since: server().load — только своя загрузка; since: метка времени — только после неё; будущее — []; -1/1.5/NaN/строка → bad_since; контракт errors(opts?: ErrorsOptions), AgentServer.load (ITGAME-155)',
      typeof e1.load === 'number' && a18.load === e1.load + 1 &&
        JSON.stringify(a18.all) === JSON.stringify([`a@${e1.load}`, `b@${a18.load}`]) &&
        JSON.stringify(a18.empty) === JSON.stringify(a18.all) &&
        JSON.stringify(a18.byLoad) === JSON.stringify([`b@${a18.load}`]) &&
        JSON.stringify(a18.byTime) === JSON.stringify([`b@${a18.load}`]) &&
        Array.isArray(a18.future) && a18.future.length === 0 &&
        a18.bad.every((c) => c === 'bad_since') &&
        a18c?.params?.[0]?.name === 'opts' && a18c.params[0].type === 'ErrorsOptions' && a18c.params[0].optional === true &&
        (a18c.returns ?? '').includes("'bad_since'") && !!T.ErrorsOptions?.fields?.since?.doc &&
        T.AgentServer?.fields?.load?.type === 'number',
      JSON.stringify({ e1, a18, params: a18c?.params, returns: a18c?.returns, opts: T.ErrorsOptions, load: T.AgentServer?.fields?.load }),
    )

    // ── A19 (ITGAME-166): itd.exit() — путь кнопки «Сохранить и выйти» без двух настоящих кликов.
    // На старом коде itd.exit нет — вызов в try, чтобы проверка упала, а не весь прогон.
    await pe.evaluate(() => {
      window.qaScenes = () => ['menu', 'hud', 'office', 'serverRoom', 'adminDept'].filter((k) => window.__itd.scene.isActive(k)).join(',')
      window.qaExit = async () => { try { return await window.itd.exit() } catch (e) { return { threw: String(e?.message ?? e) } } }
    })
    const a19menu = await pe.evaluate(async () => {
      const outs = () => window.itd.net(200).last.filter((m) => m.dir === 'out').length
      const before = outs()
      const r = await window.qaExit()
      return { r, scenes: window.qaScenes(), out: outs() - before }
    })
    await pe.evaluate(async () => {
      window.itd.click('menu.diff.normal')
      await window.itd.wait((s) => s.connected === true, 15000)
      window.itd.speed(2)
      await window.itd.wait((s) => s.speed === 2, 5000)
    })
    const a19away = await pe.evaluate(async () => {
      const back = window.itd.away(1)
      const socket = window.itd.server().socket
      const r = await window.qaExit()
      const during = { scenes: window.qaScenes(), modal: window.itd.ids().filter((n) => n.id.startsWith('modal.')).map((n) => n.id) }
      // Сервер без сейвов: возврат начинает новую партию под тем же sid (not_resumed) — вкладка снова в партии
      const ret = await back
      await window.itd.wait((s, srv) => s.connected === true && srv.socket === 'open', 10000)
      window.itd.speed(2)
      await window.itd.wait((s) => s.speed === 2, 5000)
      return { socket, r, during, back: { ok: ret.ok, code: ret.code ?? null } }
    })
    const a19 = await pe.evaluate(async () => {
      const sid = window.itd.server().liveSid
      const r = await window.qaExit()
      const srv = window.itd.server()
      const j = await window.itd.journal({ tail: 20, sid }).catch((e) => ({ error: String(e?.message ?? e) }))
      const exits = (j.records ?? []).filter((x) => x.type === 'exit').map((x) => ({ arg: x.arg ?? 0, src: x.src, err: x.err ?? null }))
      return { r, scenes: window.qaScenes(), menuReady: window.itd.state().menuReady, socket: srv.socket, liveSid: srv.liveSid, sid, exits, jerr: j.error ?? null }
    })
    const ER = T.ExitResult?.fields ?? {}
    check(
      'A19: itd.exit() — из меню not_in_party без кадра; во время away not_connected, вкладка в партии, окна нет; в партии на 2x → {ok, menuReady: true}, меню вместо hud/office, сокет closed, liveSid null, в журнале exit =2 от вкладки; ExitResult в контракте (ITGAME-166)',
      a19menu.r?.ok === false && a19menu.r.code === 'not_in_party' && a19menu.out === 0 && a19menu.scenes === 'menu' &&
        a19away.socket !== 'open' && a19away.r?.ok === false && a19away.r.code === 'not_connected' &&
        a19away.during.scenes.includes('hud') && a19away.during.modal.length === 0 &&
        a19.r?.ok === true && a19.r.menuReady === true && a19.scenes === 'menu' && a19.menuReady === true &&
        a19.socket === 'closed' && a19.liveSid === null && a19.sid === sidE &&
        a19.exits.length === 1 && a19.exits[0].arg === 2 && a19.exits[0].src === 'tab' && a19.exits[0].err === null &&
        !!ER.ok && !!ER.menuReady && (contract.methods.exit?.returns ?? '').includes("'not_in_party'") &&
        (contract.methods.cmd?.doc ?? '').includes('itd.exit()'),
      JSON.stringify({ a19menu, a19away, a19, ER: Object.keys(ER), returns: contract.methods.exit?.returns }),
    )

    // ── нет ошибок на странице за весь прогон
    check('на странице нет pageerror', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    if (browser) await browser.close()
    if (stopServer) await stopServer()
  }
}

await run()

const failed = results.filter((r) => !r.pass)
console.log(`\nИтог QA-ITGAME39: ${results.length - failed.length}/${results.length} проверок прошло`)
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
} else {
  console.log('Все проверки пройдены успешно!')
}
