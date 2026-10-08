.PHONY: help push dev dev-server dev-client test typecheck smoke-ui build sim
.DEFAULT_GOAL := help

# .env (DATABASE_URL) подхватывается автоматически; файла может не быть.
-include .env
export DATABASE_URL TEST_DATABASE_URL

help: ## список целей (по умолчанию)
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(firstword $(MAKEFILE_LIST))

push: ## git push текущей ветки в origin; пуш main = CI: тесты → stage → prod
	git push origin HEAD

dev: ## сервер и клиент параллельно
	$(MAKE) -j2 dev-server dev-client

dev-server: ## Go-сервер :8080 с ITGAME_DEBUG=1
	cd server && ITGAME_DEBUG=1 go run ./cmd/server

dev-client: ## Vite :5173
	cd client && npm run dev

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
