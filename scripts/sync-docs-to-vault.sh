#!/usr/bin/env bash
# Односторонняя синхронизация docs/ репозитория в папку проекта в Obsidian
# vault (источник истины — репо; правки в копии затираются следующим синком).
# Спека: docs/superpowers/specs/2026-07-20-sync-docs-to-vault-design.md
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vault_dir="${VAULT_DIR:-$HOME/projects/my/obsidian-vault/My/MyProjects/Site/itgame.santarinto.ru}"

if [ ! -d "$vault_dir" ]; then
    echo "ОШИБКА: vault-папка не найдена: $vault_dir" >&2
    echo "Создайте её в Obsidian или передайте VAULT_DIR=<путь>" >&2
    exit 1
fi

# --delete действует только внутри "$vault_dir/docs/" — корень vault-папки
# (рукописный паспорт itgame.santarinto.ru.md) не затрагивается.
changes="$(rsync -a --delete --itemize-changes "$repo_root/docs/" "$vault_dir/docs/")"

if [ -n "$changes" ]; then
    echo "$changes"
    total="$(printf '%s\n' "$changes" | grep -c .)"
    echo "sync-docs: изменений — $total ($vault_dir/docs)"
else
    echo "sync-docs: копия актуальна ($vault_dir/docs)"
fi
