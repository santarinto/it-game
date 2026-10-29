.PHONY: help push dev dev-server dev-client stand stand-init test typecheck smoke-ui build sim replay sprite-stub
.DEFAULT_GOAL := help

# .env (DATABASE_URL) подхватывается автоматически; файла может не быть.
-include .env
export DATABASE_URL TEST_DATABASE_URL

help: ## список целей (по умолчанию)
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

push: ## git push stand main (стенд :15555; сломанная сборка — стоп), затем текущей ветки в origin; пуш main = CI: тесты → stage → prod
	@if git remote get-url stand >/dev/null 2>&1; then git push stand main; \
	else echo "make push: remote stand нет (make stand-init) — стенд не обновлён"; fi
	git push origin HEAD

dev: ## сервер и клиент параллельно
	$(MAKE) -j2 dev-server dev-client

dev-server: ## Go-сервер :8080 с ITGAME_DEBUG=1
	cd server && ITGAME_DEBUG=1 go run ./cmd/server

dev-client: ## Vite :5173
	cd client && npm run dev

stand: ## стенд :15555 из РАБОЧЕГО дерева, с WIP (systemd --user, БД itdirector_dev); обычный деплой — git push stand main
	tools/dev-stand/stand.sh

stand-init: ## один раз: bare-репо стенда, хук деплоя, remote stand и первый git push stand main (ITGAME-139)
	tools/dev-stand/stand.sh init

test: ## Go-тесты (тестам БД нужен TEST_DATABASE_URL)
	cd server && go test ./...

typecheck: ## проверка типов клиента
	cd client && npm run typecheck

smoke-ui: ## headless-Chromium: билд открывается, menu стартует, консоль чистая
	cd client && npm run build && npm run smoke-ui

build: ## клиент в client/dist, сервер в bin/itdirector
	cd client && npm run build
	cd server && go build -o ../bin/itdirector ./cmd/server

sim: ## headless-прогоны баланса: make sim ARGS="--diff hard --seed 1..50 --days 30 --policy all"
	cd server && go run ./cmd/sim $(ARGS)

replay: ## реплей журнала партии (ITGAME-46): make replay ARGS="party.jsonl" | ARGS="-url http://localhost:8080 -sid <sid>"
	cd server && go build -o ../bin/itdirector-replay ./cmd/replay
	bin/itdirector-replay $(ARGS)

sprite-stub: ## перегенерировать заглушки спрайтов по ролям (ITGAME-243)
	cd client && npm run sprite:stub
