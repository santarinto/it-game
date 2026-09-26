// gen-contract (ITGAME-39) — строит client/src/debug/contract.gen.ts из
// interface ItdApi (client/src/debug/agentApi.ts) через TypeScript Compiler
// API: сигнатуры методов/полей, а не рукописный пересказ в HELP.
//
// Режимы:
//   node scripts/gen-contract.mjs           — записать файл, если контракт изменился
//   node scripts/gen-contract.mjs --check   — сравнить с файлом, не писать; расхождение → exit 1
//
// В обоих режимах: сверка кодов ошибок и команд протокола (client/src/protocol.ts)
// с Go (../server/internal/**/*.go) — расхождение → exit 1 с именами кодов/команд и файлами.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CLIENT = dirname(SCRIPT_DIR)
const SRC = join(CLIENT, 'src')
const SERVER = join(CLIENT, '..', 'server')
const AGENT_API = join(SRC, 'debug', 'agentApi.ts')
const OUT = join(SRC, 'debug', 'contract.gen.ts')
const CHECK = process.argv.includes('--check')

function fail(msg) {
  console.error(`gen-contract: ${msg}`)
  process.exit(1)
}

// ── 1. Программа TS над client/tsconfig.json ────────────────────────────────
const cfg = ts.getParsedCommandLineOfConfigFile(join(CLIENT, 'tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  },
})
if (!cfg) fail(`не смог разобрать ${join(CLIENT, 'tsconfig.json')}`)
const program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options })
const checker = program.getTypeChecker()

const agentApiSf = program.getSourceFile(AGENT_API)
if (!agentApiSf) fail(`не нашёл ${AGENT_API} в программе (проверьте tsconfig include)`)
const apiDecl = agentApiSf.statements.find(
  (s) => ts.isInterfaceDeclaration(s) && s.name.text === 'ItdApi',
)
if (!apiDecl) fail(`не нашёл 'interface ItdApi' в ${AGENT_API}`)

const F =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
  ts.TypeFormatFlags.WriteArrowStyleSignature
// InTypeAlias — печатает РАЗВЁРНУТУЮ форму типа вместо его собственного
// имени: без флага typeToString(t) на алиасе с прикреплённым aliasSymbol
// (MemberSpec, TypeSpec — «type X = A | B») печатает просто "X" (то же имя),
// потому что TS кеширует резолвленный тип на узле уже помеченным этим
// symbol'ом. Нужен только в ветке 'alias' (замыкание по алфавиту, п.4).
const F_ALIAS = F | ts.TypeFormatFlags.InTypeAlias
const str = (t, node, flags = F) => checker.typeToString(t, node, flags)
const doc = (sym) => ts.displayPartsToString(sym.getDocumentationComment(checker)).trim()
const examplesOf = (sym) =>
  sym
    .getJsDocTags()
    .filter((t) => t.name === 'example')
    .map((t) => (t.text ?? []).map((p) => p.text).join('').trim())
    .filter((s) => s.length > 0)

// ── 2. Замыкание именованных типов (BFS по type-узлам членов) ──────────────
const named = new Map() // имя типа → декларация
const queue = []
function collect(node) {
  if (!node) return
  if (ts.isTypeReferenceNode(node)) {
    let sym = checker.getSymbolAtLocation(node.typeName)
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    const d = sym?.declarations?.[0]
    if (
      d &&
      d.getSourceFile().fileName.startsWith(SRC + '/') &&
      (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) &&
      !named.has(sym.name)
    ) {
      named.set(sym.name, d)
      queue.push(d)
    }
  }
  ts.forEachChild(node, collect)
}

// ── 3. Члены ItdApi → methods (в порядке объявления) ────────────────────────
const methods = {}
for (const m of apiDecl.members) {
  const sym = checker.getSymbolAtLocation(m.name)
  const name = m.name.getText()
  collect(m)
  const d = doc(sym)
  if (!d) fail(`ItdApi.${name} без JSDoc — добавьте /** описание */ над членом`)
  if (ts.isMethodSignature(m)) {
    const sig = checker.getSignatureFromDeclaration(m)
    methods[name] = {
      kind: 'method',
      params: sig.parameters.map((p) => {
        const pd = p.valueDeclaration
        return {
          name: p.name,
          type: pd.type
            ? str(checker.getTypeFromTypeNode(pd.type), pd)
            : str(checker.getTypeOfSymbolAtLocation(p, pd), pd),
          optional: !!(pd.questionToken || pd.initializer),
        }
      }),
      returns: str(sig.getReturnType(), m),
      doc: d,
      examples: examplesOf(sym),
    }
  } else {
    methods[name] = {
      kind: 'prop',
      type: str(checker.getTypeAtLocation(m), m),
      readonly: !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword),
      doc: d,
    }
  }
}

// ── 4. Замыкание типов → types (по алфавиту в выводе) ───────────────────────
const typesUnsorted = {}
while (queue.length) {
  const d = queue.shift()
  collect(d)
  const t = checker.getTypeAtLocation(d.name)
  if (t.isUnion() && t.types.every((x) => x.isStringLiteral())) {
    typesUnsorted[d.name.text] = { kind: 'enum', values: t.types.map((x) => x.value).sort() }
  } else if (ts.isInterfaceDeclaration(d) || (ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type))) {
    const fields = {}
    for (const p of checker.getPropertiesOfType(t)) {
      const pd = p.valueDeclaration
      const fieldType = pd?.type
        ? str(checker.getTypeFromTypeNode(pd.type), pd)
        : str(checker.getTypeOfSymbolAtLocation(p, pd ?? d), pd ?? d)
      const jsDoc = ts.displayPartsToString(p.getDocumentationComment(checker)).trim()
      const trailing = pd
        ? (ts.getTrailingCommentRanges(pd.getSourceFile().text, pd.end) ?? [])
            .map((r) => pd.getSourceFile().text.slice(r.pos + 2, r.end).trim())
            .join(' ')
        : ''
      fields[p.name] = {
        type: fieldType,
        optional: !!(p.flags & ts.SymbolFlags.Optional),
        doc: jsDoc || trailing,
      }
    }
    const idx = checker.getIndexInfosOfType(t)
    typesUnsorted[d.name.text] = {
      kind: 'object',
      fields,
      ...(idx.length ? { index: idx.map((i) => `[k: ${str(i.keyType)}]: ${str(i.type)}`) } : {}),
    }
  } else {
    typesUnsorted[d.name.text] = { kind: 'alias', type: str(t, d, F_ALIAS) }
  }
}
const types = {}
for (const name of Object.keys(typesUnsorted).sort()) types[name] = typesUnsorted[name]

// ── 5. Сверка кодов ошибок и команд протокола с Go ──────────────────────────
if (!existsSync(SERVER)) fail(`нет ${SERVER} — нужен соседний checkout сервера для сверки кодов/команд`)

function walkGoFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkGoFiles(p))
    else if (entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) out.push(p)
  }
  return out
}

// value → Set<относительный путь файла>, для читаемого сообщения об ошибке
function scanGo(files, patterns) {
  const found = new Map()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const rel = relative(SERVER, f)
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) {
        const key = m[1]
        if (!found.has(key)) found.set(key, new Set())
        found.get(key).add(rel)
      }
    }
  }
  return found
}

function constArrayFromFile(sf, varName) {
  let out = null
  const visit = (node) => {
    if (out) return
    if (ts.isVariableDeclaration(node) && node.name.getText() === varName && node.initializer) {
      let init = node.initializer
      if (ts.isAsExpression(init)) init = init.expression
      if (ts.isArrayLiteralExpression(init)) {
        out = init.elements.map((el) => {
          if (!ts.isStringLiteralLike(el)) {
            throw new Error(`${varName}: элемент массива не строковый литерал — ${el.getText()}`)
          }
          return el.text
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!out) fail(`не нашёл 'export const ${varName} = [...] as const' в ${sf.fileName}`)
  return out
}

function reportSetDiff(label, clientSet, goMap, clientFile) {
  const goSet = new Set(goMap.keys())
  const onlyClient = [...clientSet].filter((x) => !goSet.has(x)).sort()
  const onlyGo = [...goSet].filter((x) => !clientSet.has(x)).sort()
  if (onlyClient.length === 0 && onlyGo.length === 0) return
  console.error(`gen-contract: ${label} разошлись между клиентом и Go:`)
  if (onlyClient.length) {
    console.error(`  только в ${clientFile}: ${onlyClient.join(', ')}`)
  }
  for (const code of onlyGo) {
    console.error(`  только в Go (${code}): ${[...goMap.get(code)].sort().join(', ')}`)
  }
  process.exitCode = 1
}

const goFiles = walkGoFiles(join(SERVER, 'internal'))
const goErrorCodes = scanGo(goFiles, [
  /\bErr\("([a-z_]+)"\)/g,
  /errorMessage\{[^}]*Code:\s*"([a-z_]+)"/g,
])
const goCommands = scanGo(goFiles, [/\bCommand\("([a-z_]+)"\)/g])

const protocolSf = program.getSourceFile(join(SRC, 'protocol.ts'))
if (!protocolSf) fail(`не нашёл ${join(SRC, 'protocol.ts')} в программе`)
const clientErrorCodes = new Set(constArrayFromFile(protocolSf, 'SERVER_ERROR_CODES'))
const clientCommands = new Set(constArrayFromFile(protocolSf, 'COMMAND_TYPES'))

reportSetDiff('коды ошибок (SERVER_ERROR_CODES)', clientErrorCodes, goErrorCodes, 'client/src/protocol.ts')
reportSetDiff('команды (COMMAND_TYPES)', clientCommands, goCommands, 'client/src/protocol.ts')
if (process.exitCode === 1) process.exit(1)

// ── 6. hash + сборка файла ───────────────────────────────────────────────────
const schema = 1
const hash = createHash('sha256')
  .update(JSON.stringify({ schema, methods, types }))
  .digest('hex')
  .slice(0, 12)

const fileBody = JSON.stringify({ schema, hash, methods, types }, null, 2)
const content =
  `// СГЕНЕРИРОВАНО scripts/gen-contract.mjs из ItdApi — руками не править. npm run gen:contract\n` +
  `import type { ItdApi, MemberSpec, TypeSpec } from './agentApi'\n` +
  `export const CONTRACT = ${fileBody} satisfies { schema: 1; hash: string; methods: { [K in keyof ItdApi]-?: MemberSpec }; types: Record<string, TypeSpec> }\n`

// ── 7. Запись/сверка ─────────────────────────────────────────────────────────
if (CHECK) {
  if (!existsSync(OUT)) fail(`нет ${OUT} — сначала npm run gen:contract`)
  const current = readFileSync(OUT, 'utf8')
  if (current === content) {
    console.log(`gen-contract --check: contract.gen.ts актуален (hash ${hash})`)
    process.exit(0)
  }
  const a = current.split('\n')
  const b = content.split('\n')
  const max = Math.max(a.length, b.length)
  const lines = []
  for (let i = 0; i < max && lines.length < 20; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) lines.push(`-${i + 1}: ${a[i]}`)
    if (b[i] !== undefined) lines.push(`+${i + 1}: ${b[i]}`)
  }
  console.error(`gen-contract --check: contract.gen.ts расходится с ItdApi (первые ${lines.length} отличий):`)
  for (const l of lines) console.error('  ' + l)
  console.error('Подсказка: npm run gen:contract')
  process.exit(1)
} else {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  if (current === content) {
    console.log(`gen-contract: contract.gen.ts не изменился (hash ${hash})`)
  } else {
    writeFileSync(OUT, content)
    console.log(`gen-contract: записал ${relative(CLIENT, OUT)} (hash ${hash}, methods=${Object.keys(methods).length}, types=${Object.keys(types).length})`)
  }
}
