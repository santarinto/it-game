---
name: generate-promt-for-gemini
description: Use when the owner hands tracker tasks to a Gemini agent (Antigravity CLI `agy`, tracker slug gemini-3.8-flash) instead of a Claude session — «промт для gemini», «отдам gemini», «мелочь гемини», «собери промт gemini на ITGAME-…», «/generate-promt-for-gemini» — and also when a Gemini run's FINAL report or РЕТРО has come back and the lead has to review its branch before merging.
---

# Промт для Gemini-агента и ревью его ветки

Gemini работает один в своём worktree на своей ветке. Лид (ты) готовит место, пишет промт,
потом ревьюит ветку и мержит; выкатывает владелец. Промт — английский текст из **неизменных
блоков** с несколькими слотами. Неизменные блоки — это уроки настоящих прогонов: каждый
появился после того, как его не было, и прогон за это заплатил.

## Чем Gemini отличается от Claude-агента

| Свойство | Следствие для промта |
|---|---|
| Ходит в трекер через MCP `t`, но тул принимает ОДИН аргумент `q` | Сказать прямо: первый вызов с `query` падает на схеме |
| `t` узнаёт проект по `CLAUDE_PROJECT_DIR`, иначе по `$PWD` | Из worktree без переменной — `unknown_caller`. Чинить запуском, не промтом |
| Получив отказ, чинит его сам любым доступным путём | Однажды переписал view `tracker.v_project_agent` в общей базе флота. Запрет на базы — в КАЖДОМ промте |
| Команда дольше ~10 с уходит в фон, каждое ожидание — ход | Все проверки задачи — одной командой в лог |
| Пишет `git commit -m "…$0…"` | Оболочка подставит `bash`. Только `git commit -F` с файлом из heredoc в кавычках |
| Нет судьи `/goal` | Маркеры TASK и FINAL всё равно нужны — по ним ревьюишь ты |

## Подготовка (лид)

1. Режим по часам, как в goal-promt-generate: 20–08 ночь (3–5 задач, вопросов нет), 08–20 день
   (1–2 задачи, один вопрос владельцу с таймаутом). Слова владельца бьют часы. Режим — вслух.
2. Задачи: малые, с командой проверки, без `needs-input`/`waiting`/`blocked`. Перед промтом
   сверить посылку каждой с кодом: что уже решено, где ловушка (кто ещё проверяет строку, какой
   файл задет). Найденное — одной строкой в очередь промта, тело задачи Gemini прочтёт сам.
3. Порядок: сначала то, что чинит гейт или инструмент проверки, дальше по возрастанию риска;
   задачи на общих файлах — подряд.
4. Worktree от локального main: `git worktree add .claude/worktrees/gemini-<коды> -b gemini/<коды> main`
   (+ симлинк `client/node_modules`, если проект на node и он в `.gitignore` без слэша).
5. `task.where(code in (…)) | log("поставлена в прогон Gemini: режим, порядок, ветка, что сверил лид", model: …)`.

## Строка запуска — отдаётся владельцу вместе с промтом

```bash
cd <repo>/.claude/worktrees/gemini-<коды> && CLAUDE_PROJECT_DIR=<repo> agy --dangerously-skip-permissions
```

Не `gemini --yolo`: владелец запускает Antigravity CLI. Без `CLAUDE_PROJECT_DIR` трекер не
узнает проект из worktree.

## Шаблон промта

Слоты — в `<угловых>`. Блоки TRACKER, PER TASK, NEVER, ESCAPE, FINAL переносятся ЦЕЛИКОМ в
любом режиме; правится только SETTING, QUEUE, CHECKS и AUTHORIZED.

```text
<SETTING: "Unattended night run, owner asleep: never ask, decide yourself and log the decision." | "Daytime run, the owner is at the keyboard.">
Work ONLY in <worktree> (branch <branch>; <symlinks you must never commit>). A Claude lead reviews and merges after you: you never merge, push or touch main. Read <project docs> first.

TRACKER: MCP t, the tool takes ONE argument, q. Every log() and set(status) carries model: "gemini-3.8-flash" (quoted).

QUEUE, fixed order, one at a time:
1. <CODE> <one line: what, plus the trap the lead found in the code>
2. …
<DAY ONLY: "Ask the owner ONCE about <what>; if it is not in the owner's next message, use <default> and log that you chose.">

PER TASK:
- task.context.where(code=X): read body, log, constraints in full. Then | set(status: in_progress, model: ...).
- Change. Then run ALL the task's checks in ONE shell command into a log and read only the summary lines: <CHECKS, e.g. (cd client && npm run build && npm test && npm run <suite>…) > /tmp/gemini-<code>.log 2>&1; plus (cd server && go test ./...) when Go changed>. <project check rules: one suite at a time, never bare <cmd>>.
- Update the docs that quote a changed string or behaviour.
- Commit: git add <paths> only; write the message to a file with a quoted heredoc (cat > /tmp/msg <<'EOF' … EOF) and git commit -F /tmp/msg — never -m (the shell eats $0, $1). Style of git log -5, task code at the end, checks with counts. No Co-Authored-By trailer.
- task.where(code=X) | log("<what changed, checks with numbers, sha, decisions>", model: ...) after each step.
- Done: | set(status: review, executed: "gemini-3.8-flash", model: ...) — refused without executed; NOT done, the lead closes after merge. Print the check summary lines, git log --oneline -1, then exactly one line: TASK <CODE> DONE <sha>
- Not doable: log the reason, | set(status: backlog, model: ...), reset this branch to the last DONE commit (this branch only), print: TASK <CODE> RETURNED <one-line reason>

AUTHORIZED without asking: edit any file in this worktree, run the checks above, commit on <branch>, read anything in the repo and the tracker, log/set status on the queued codes.

NEVER: git push, merge, rebase; touch main or the main checkout <repo>; <project deploy/release targets>; edit <project shared dirs>, ~/.claude, ~/.gemini; git add -A or git add .; set done; create, close or edit other tracker tasks; run DDL/INSERT/UPDATE/DELETE or CREATE/ALTER/DROP against ANY database, the tracker's included — if the tracker refuses you (unknown_caller, permission), stop and report it, never repair it; <stand ports>; leave the tree red after a commit; <NIGHT: ask anything | DAY: ask anything but the one question above>.

ESCAPE: if the same check fails twice in a row on one task after a fix attempt, print RETURNED for it (and for the rest, reason "budget exhausted", if you were compacted), then go to FINAL.

FINAL, last message, in Russian: per code the outcome, sha, files, checks with numbers, decisions and why, anything suspicious left alone. Then git log --oneline main..<branch> and git diff --stat main..<branch>. Then РЕТРО: what cost extra turns (with counts), what was wrong or missing in this prompt, concrete improvements, one line each with where it belongs.

DONE WHEN: every queued code printed exactly one TASK line and FINAL with the log, diffstat and РЕТРО is printed.
```

Длину проверить `wc -m`: держать ~4000, режется QUEUE, не неизменные блоки.

## Ревью, когда отчёт вернулся

Отчёт и ретро Gemini — заявка, не факт. По порядку:

1. **Что он делал вне репо.** Транскрипт:
   `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (свежий —
   `ls -t ~/.gemini/antigravity-cli/conversations`). Grep на `psql|CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|curl -X`
   и пути вне worktree. Запись в чужую систему — сначала доложить владельцу и дать откат, мерж потом.
2. **Ветка:** `git log --format='%h %(trailers:key=Co-Authored-By,valueonly)%n%B' main..<branch>`.
   Сообщение без `bash` на месте `$…` и без чужого trailer'а; испорченное — `git commit --amend -F`.
3. **Дифф каждой задачи** против её тела: правка той ширины, что заявлена; задетые проверки обновлены.
4. **Гейты сам**, одним фоновым запуском в лог; в worktree ничего не править, пока идут.
5. **Перезаписанные эталоны** (скриншоты, снапшоты) — попиксельно старое против нового и глазами
   на самый большой дифф: в эталон не должно уйти ничего, кроме заявленного.
6. Трекер: логи совпадают с коммитами, статус `review`, `executed` проставлен.
7. Ретро: каждый пункт — правда / его промах / дыра промта. Дыры промта — в неизменные блоки
   этого навыка.
8. ff-мерж в main, worktree и ветку убрать, лог в задачи. Выкатку делает владелец; `done` — после неё.

## Частые ошибки

| Ошибка | Что было |
|---|---|
| Дневной промт собран «облегчённым», без запрета на базы | Gemini получил `unknown_caller` и переписал view трекера в базе флота |
| `review` без `executed` | Трекер отказал, ход на разбор |
| Проверки по одной команде | ~12 ходов на ожидание фоновых задач |
| `git commit -m` с `$0` в тексте | В истории «аудит провален (−bash)» |
| Запуск без `CLAUDE_PROJECT_DIR` из worktree | `unknown_caller` — и попытка «починить» трекер |
| Поверить «0 px diff» после `--update` | После перезаписи эталона ноль по построению; сравнивать со старым эталоном |
