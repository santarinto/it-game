# Sync docs → Obsidian vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Команда `make sync-docs`, односторонне синхронизирующая `docs/` репозитория в папку проекта в Obsidian vault.

**Architecture:** Один shell-скрипт `scripts/sync-docs-to-vault.sh` (bash + rsync `-a --delete` в подпапку `docs/` внутри vault-папки проекта) и make-цель `sync-docs`, которая его вызывает. Источник истины — репо; правки в копии затираются.

**Tech Stack:** bash, rsync, make.

## Global Constraints

- Путь vault по умолчанию: `$HOME/projects/my/obsidian-vault/My/MyProjects/Site/itgame.santarinto.com`, переопределяется env `VAULT_DIR` (спека).
- Копия кладётся ТОЛЬКО в `<VAULT_DIR>/docs/`; файлы в корне vault-папки (рукописный `itgame.santarinto.com.md`) не трогать (спека).
- Если `VAULT_DIR` не существует — понятная ошибка, exit != 0, никаких побочных эффектов (спека).
- Содержимое файлов не модифицируется — точная копия (спека).
- Спека: `docs/superpowers/specs/2026-07-20-sync-docs-to-vault-design.md`.

---

### Task 1: Скрипт синхронизации + make-цель

**Files:**
- Create: `scripts/sync-docs-to-vault.sh` (исполняемый)
- Modify: `Makefile:1` (список .PHONY) и конец файла (новая цель)

**Interfaces:**
- Consumes: `docs/` в корне репо (существует).
- Produces: команда `make sync-docs`; скрипт можно звать и напрямую: `bash scripts/sync-docs-to-vault.sh` (env `VAULT_DIR` — переопределение пути).

- [ ] **Step 1: Написать скрипт**

Создать `scripts/sync-docs-to-vault.sh`:

```bash
#!/usr/bin/env bash
# Односторонняя синхронизация docs/ репозитория в папку проекта в Obsidian
# vault (источник истины — репо; правки в копии затираются следующим синком).
# Спека: docs/superpowers/specs/2026-07-20-sync-docs-to-vault-design.md
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vault_dir="${VAULT_DIR:-$HOME/projects/my/obsidian-vault/My/MyProjects/Site/itgame.santarinto.com}"

if [ ! -d "$vault_dir" ]; then
    echo "ОШИБКА: vault-папка не найдена: $vault_dir" >&2
    echo "Создайте её в Obsidian или передайте VAULT_DIR=<путь>" >&2
    exit 1
fi

# --delete действует только внутри "$vault_dir/docs/" — корень vault-папки
# (рукописный паспорт itgame.santarinto.com.md) не затрагивается.
changes="$(rsync -a --delete --itemize-changes "$repo_root/docs/" "$vault_dir/docs/")"

if [ -n "$changes" ]; then
    echo "$changes"
    total="$(printf '%s\n' "$changes" | grep -c .)"
    echo "sync-docs: изменений — $total ($vault_dir/docs)"
else
    echo "sync-docs: копия актуальна ($vault_dir/docs)"
fi
```

Сделать исполняемым: `chmod +x scripts/sync-docs-to-vault.sh`.

- [ ] **Step 2: Проверить кейс «vault-папки нет» (без побочных эффектов)**

Run: `VAULT_DIR=/tmp/no-such-vault-dir bash scripts/sync-docs-to-vault.sh; echo "exit=$?"; ls /tmp/no-such-vault-dir 2>&1`
Expected: строка `ОШИБКА: vault-папка не найдена…`, `exit=1`, каталог НЕ создан (`ls` даёт "No such file or directory").

- [ ] **Step 3: Проверить успешный синк и повторный прогон на временной папке**

Run:
```bash
tmp=$(mktemp -d)
VAULT_DIR="$tmp" bash scripts/sync-docs-to-vault.sh
diff -r docs "$tmp/docs" && echo "IDENTICAL"
VAULT_DIR="$tmp" bash scripts/sync-docs-to-vault.sh
```
Expected: первый прогон печатает список изменений и `sync-docs: изменений — N`; `IDENTICAL`; второй прогон — `sync-docs: копия актуальна …`.

- [ ] **Step 4: Проверить, что удаления доезжают, а корень vault-папки не трогается**

Run:
```bash
touch "$tmp/handmade-passport.md"
mkdir -p "$tmp/docs"
touch "$tmp/docs/stale-file.md"
VAULT_DIR="$tmp" bash scripts/sync-docs-to-vault.sh
ls "$tmp/docs/stale-file.md" 2>&1
ls "$tmp/handmade-passport.md" && rm -rf "$tmp"
```
Expected: `stale-file.md` удалён (`No such file or directory`), `handmade-passport.md` на месте.

- [ ] **Step 5: Добавить make-цель**

В `Makefile` строку 1 заменить:

```makefile
.PHONY: dev dev-server dev-client test typecheck build sync-docs
```

В конец файла добавить:

```makefile
sync-docs: ## docs/ -> Obsidian vault (односторонне, источник истины — репо)
	bash scripts/sync-docs-to-vault.sh
```

(отступ — TAB, как в остальных целях.)

- [ ] **Step 6: Прогнать по-настоящему**

Run: `make sync-docs && ls ~/projects/my/obsidian-vault/My/MyProjects/Site/itgame.santarinto.com/docs/`
Expected: итоговая строка скрипта; в vault появились `passport.md`, `stages/`, `design/`, `superpowers/`; рукописный `itgame.santarinto.com.md` в корне папки не изменён.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-docs-to-vault.sh Makefile
git commit -m "feat: make sync-docs — синхронизация docs/ в Obsidian vault"
```
