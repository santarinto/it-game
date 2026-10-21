---
name: goal-promt-generate-v2
description: Use when the owner wants an autonomous /goal run whose tasks the agent picks from the backlog itself, not from codes the owner named — «собери прогон из бэклога», «найди автономные задачи и прогони», «goal v2», «/goal-promt-generate-v2» — or asks for the run to be executed by a multi-model subagent pipeline in worktrees. For a /goal prompt over already-named tasks worked by the lead alone, use goal-promt-generate.
---

# Прогон из бэклога конвейером субагентов (`/goal`, v2)

От v1 (`goal-promt-generate`) отличается в двух местах:

1. **Задачи выбирает навык.** Бэклог делится на автономные задачи, на задачи, которые станут
   автономными после ОДНОГО вопроса владельцу, и на всё остальное. Вопросы задаются сейчас, пока
   владелец рядом (он же вызвал навык), а ответы пишутся в журнал задачи до старта прогона.
2. **Прогон исполняет конвейер.** Лид раздаёт работу и гоняет тесты, но код не пишет.
   Порядок: разведка на Fable → планы на Opus → код на Sonnet → тесты на Haiku → ревью
   Sonnet + Opus. Порядок и файлы задаёт `protocol.md` рядом с этим файлом: он копируется в папку
   прогона и заполняется.

После каждого прогона проводится разбор: что в протоколе мешало, то и правится, в `protocol.md`
и здесь. Первый прогон — `20260926-0121` (SLA-722), 4 задачи: 3 в done, 1 в qa, $50 на всё.
Лид: 200 ответов, пик контекста 315k. Самый дорогой субагент — Sonnet-исполнитель: 124 ответа,
пик 349k, $7.6. Fable-разведка: 15 ответов, $4.8. 26 прогонов test-runner — $1.3 на всех.

## Шесть свойств `/goal`, из которых следует форма промта

| Свойство | Что из него следует |
|---|---|
| Судья видит только диалог, инструментов не вызывает | засчитывается только напечатанное: маркерные строки |
| Вердикт impossible гасит цель насовсем | у каждой задачи легальный выход RETURNED |
| Лимит условия — 4000 символов | протокол живёт в `run.md`, промт на него ссылается |
| Ходы без вызова инструментов останавливают цикл | каждый ход — действие; дневной вопрос с таймаутом |
| Переполнение контекста гасит цель | прогресс пишется в трекер и в `run.md`; на контексте 1M компакт наступает позже потолка ~290k из AGENTS.md, поэтому настоящий предохранитель — длина цепочки (шаг 5) |
| `/goal` не меняет режим разрешений | запускать в auto mode, разрешения ещё и текстом |

Если цепочка трогает браузер, рецепт брать из раздела «Браузер» навыка `goal-promt-generate`,
урезанный по режиму.

## Шаг 0. Часы

`date '+%H:%M %A'`. С 20:00 до 08:00 ночь, иначе день; режим, названный в вызове, важнее
часов. Режим объявляется одной строкой. От режима зависит только поведение ВНУТРИ прогона:
ночью вопросов нет вовсе, днём вопрос с таймаутом в один ход. Вопросы на этапе отбора задаются в
любом режиме.

## Шаг 1. Доска одним вызовом

`board.backlog`: open, waiting, blocked, constraint и sys.wip в одном ответе. Кандидаты
берутся из open. Waiting, blocked и тег `needs-input` в прогон не идут.

## Шаг 2. Три корзины

Детали читаются только у кандидатов:
`task.where(code in (…)).select(code, est, pri, activity, summary(body), dependents, related).take(10)`.
`summary` — пересказ; прежде чем утверждать факт, брать `select(body)`.

| Корзина | Признак | Куда |
|---|---|---|
| **A** автономна | есть команда, доказывающая результат, и решение за агентом | в цепочку |
| **B** автономна после вопроса | не хватает ровно одного решения владельца, и оно укладывается в выбор из 2–4 вариантов | вопрос на шаге 4, потом в цепочку |
| **C** вне прогона | хотя бы один признак ниже | назвать с причиной одной строкой |

Признаки корзины C: ждёт чужого ответа; L или XL без названного первого шага (тогда берётся
только первый шаг); результат нечем доказать командой; решение не выбор из вариантов, а
направление продукта; нужно больше одного вопроса; задача правит чужой репозиторий.

**Глаз владельца задачу НЕ дисквалифицирует**: конвейер кончается на `qa`, а смотреть владелец
будет после. Дисквалифицирует только глаз, нужный ПОСРЕДИ работы («какой из двух видов лучше»):
такой вопрос уходит в B, либо задача уходит в C.

## Шаг 3. Актуализация — не больше трёх вызовов на задачу

На каждую задачу из A и B:
- `git log --oneline --grep=<CODE>`: вдруг часть уже сделана;
- сверить посылку задачи с кодом, по порядку поиска из правил проекта;
- `task.context.where(code=X)`: ограничения. `deny` с охватом work или close, которое без
  владельца не выполнить, отправляет задачу в C.

Посылка разошлась с кодом — это вопрос (B) или C. Найденное пишется в журнал:
`[actualize · <model-id>] …`. Всё, что глубже трёх вызовов, достаётся разведке: записывается
в `run.md` в «left for recon».

## Шаг 4. Вопросы владельцу — сейчас и пачкой

`AskUserQuestion`: до четырёх вопросов за вызов, первым вариантом рекомендуемый. На задачу
один вопрос. Каждый ответ пишется в журнал задачи:
`[owner · <дата>] <вопрос> → <ответ>`. Разведка читает журнал, пересказывать ответ в промте не
надо.

Последним вопросом идёт сама цепочка: коды, по строке на каждый, и «Запускаем?». Ответ «убери
X» переносит X в C.

## Шаг 5. Цепочка

- **Две–четыре задачи, четыре — потолок.** Предел здесь — контекст лида, а не число субагентов:
  на четырёх задачах лид сделал 200 ответов и дошёл до 315k, выше потолка ~290k. Предохранитель по
  компакту на контексте 1M до этого не срабатывает.
- Порядок: сначала то, что чинит инструмент или гейт, дальше по возрастанию риска. Этот порядок
  становится порядком слияния.
- Параллельность окончательно решает разведка. Навык только отмечает очевидное: задачи с общими
  файлами или с двумя миграциями параллельно не идут.
- В конвейере все задачи могут стоять в `in_progress` одновременно, поэтому свободных слотов
  нужно не меньше длины цепочки, иначе волнами. Слоты берутся из sys.wip, по памяти не считать.

## Шаг 6. Папка прогона, `run.md` и промт

1. `stamp=$(date +%Y%m%d-%H%M)`. Папка прогона `<repo>/var/goal/<stamp>/`, если
   `git check-ignore -q var/goal/x` отвечает «игнорируется», иначе `/tmp/goal-<stamp>/`.
2. Скопировать `protocol.md` в `<RUN>/run.md` и заполнить шапку: цепочку, режим, команды проверки
   (из CLAUDE.md, AGENTS.md, `make help`), команду деплоя, как вызывается test-runner, корень
   worktree, «left for recon». Остальной протокол не править: он общий на все прогоны.
3. Собрать промт по шаблону ниже, записать в `<RUN>/goal.txt`, `wc -m < <RUN>/goal.txt` должно
   быть меньше 4000.
4. На каждую задачу записать в журнал:
   `[goal-plan · <model-id>] в прогоне <stamp>, позиция N из M, протокол <RUN>/run.md`.
5. Вывести промт в чат целиком, в блоке кода, БЕЗ ведущего `/goal`.
6. Одной строкой сказать, как запускать: **в свежей сессии** (определения агентов вроде
   test-runner грузятся при старте процесса, `/clear` их не перечитывает), в auto mode, набрать
   `/goal` и вставить текст.
7. Назвать риск: контекст лида. После прогона провести разбор.

### Разбор после прогона

Материал — `<RUN>/agents.md`, `side-findings.md`, `final-review.md`, журналы задач и сессия
лида в `ai.transcript_*`. Её `session_id` находится по `cwd` и `first_ts` в
`ai.transcript_session FINAL`. Цена и контекст по субагентам (id те же, что в `agents.md`):

```sql
WITH r AS (SELECT agent_id, if(message_id = '', uuid, message_id) AS rid, any(model) AS m,
  max(input_tokens + cache_read_tokens + cache_creation_tokens) AS inp, sum(cost_usd) AS usd
  FROM ai.transcript_message FINAL WHERE session_id = '<id>' AND role = 'assistant'
  GROUP BY agent_id, rid)
SELECT agent_id, any(m), count() AS responses, max(inp) AS peak_ctx, round(sum(usd), 2) AS usd
FROM r GROUP BY agent_id ORDER BY usd DESC
```

Ошибки инструментов — `ai.transcript_tool_call FINAL`, `is_error = 1`, `error_preview`; записи
лида — `agent_id = ''`. Правится то, что стоило лиду ходов или прогону денег; итог разбора пишется
в журнал задачи прогона одной записью с цифрами.

### Шаблон промта (заполнить угловые скобки)

```
Setting: <Unattended night run, owner asleep | Daytime run, owner at the keyboard>. You are the LEAD of a subagent pipeline. Protocol: <RUN>/run.md - read it fully before anything else; for this run it overrides your defaults.

Queue (fixed order = merge order; the recon decides what runs in parallel):
1. <CODE> - <one line>
2. <CODE> - <one line>

Pipeline per run.md: ONE Fable recon subagent for the whole queue writes a planner prompt per task -> one Opus planner per task, in that task's worktree, writes plan.md -> Sonnet implementers in the worktrees never run checks, they hand back "READY <command>" -> you run EVERY check through the test-runner subagent (haiku), one at a time, and relay its verdict verbatim -> status review, one Sonnet reviewer per worktree -> merge into the integration worktree, make check, one Opus reviewer on the combined diff -> ff main -> make deploy -> close.

Every stage writes one tracker entry, in Russian, carrying only what is nowhere else: task.where(code=X) | log("[<stage> · <model-id>] ...", model: <model-id>) — the tracker refuses log(), set(status: …), pause and resume without model:. After a compaction rebuild state from run.md, <RUN>/*/ files and the task logs, never from memory.

Close: a purely technical task -> set(status: done, reason: ..., model: <model-id>); a task with a visible result -> set(status: qa, model: <model-id>) with its qa field filled (steps, links to this project's own portal at the address its AGENTS.md names — localhost:12800 is support.local's portal, not every project's; expected numbers; no keyboard or screen-reader steps).

After each task print exactly one line:
TASK <CODE> DONE <sha> | TASK <CODE> QA <sha> | TASK <CODE> RETURNED <one-line reason>
RETURNED exactly as run.md "RETURN a task" says. After the last TASK line print a block headed QA-INSTRUCTIONS (or the line "QA-INSTRUCTIONS: none"), then file the side findings per run.md stage 8 and print one SIDE <code> <title> line each (or "SIDE: none").

Authorized without asking: git worktrees and wt/* branches (create, rebase, remove), composer install, npm ci, commits (atomic, Russian message in the project's style, task code in it), ff-merge into main, every make target including make check and make deploy (sudo is NOPASSWD), migrations through the project's commands, tracker writes via t (status, log, qa field), read-only SQL, every skill, MCP server and subagent model run.md names.

Never: git push or any remote operation; force-push or history rewrite; git add -A; psql, or any write to the live DB outside migrations and sp_*; editing another project's repo; two test runs at once; a test run inside your own or an implementer's context; <NIGHT: asking the owner anything | DAY: waiting for an answer longer than one turn - decide and log it>; ending a turn without a tool call; leaving main red.

A task red 3 times after your own direction is RETURNED alone (run.md stage 4); the others go on. Fuse: once you have been compacted, start no new stage for tasks that have not passed their worktree review - each prints RETURNED "budget exhausted"; finish integrate, deploy and close for the rest.

Done when every queue code has printed exactly one TASK line and the QA-INSTRUCTIONS block and the SIDE lines are printed.
```

## Частые ошибки

| Соблазн | Реальность |
|---|---|
| «Задачу, где нужен глаз, выброшу» | Конвейер кончается на `qa`, и глаз приходит после. Выбрасывать надо только глаз, нужный посреди работы. |
| «Задам вопрос внутри прогона» | Ночью этот вопрос повиснет до утра. Все вопросы задаются на шаге 4. |
| «Два вопроса к одной задаче — ничего» | Второй вопрос значит, что задача не созрела: она уходит в C. |
| «Актуализирую как следует, это же дешевле разведки» | Три вызова на задачу. Остальное делает Fable, иначе контекст лида съеден ещё до старта. |
| «Пусть исполнитель сам прогонит один тест» | Вывод теста оседает в контексте Sonnet и переоплачивается на каждом его ходу; вдобавок два прогона сталкиваются в общей тестовой БД. |
| «Запущу `/goal` в этой же сессии» | Агента test-runner, добавленного после старта процесса, в сессии нет. Нужна свежая сессия. |
| «Пусть отчитается в конце» | Отчёт в конце не переживёт компакта. Журнал пишется после каждой стадии. |
