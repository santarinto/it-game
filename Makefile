.PHONY: dev dev-server dev-client test typecheck smoke-ui build sim sync-docs

# .env (DATABASE_URL) подхватывается автоматически; файла может не быть.
-include .env
export DATABASE_URL TEST_DATABASE_URL

dev: ## сервер и клиент параллельно
	$(MAKE) -j2 dev-server dev-client

dev-server:
	cd server && go run ./cmd/server

dev-client:
	cd client && npm run dev

test:
	cd server && go test ./...

typecheck:
	cd client && npm run typecheck

smoke-ui: ## headless-Chromium: билд открывается, menu стартует, консоль чистая
	cd client && npm run build && npm run smoke-ui

build:
	cd client && npm run build
	cd server && go build -o ../bin/itdirector ./cmd/server

sim: ## headless-прогоны баланса: make sim ARGS="--diff hard --seed 1..50 --days 30 --policy all"
	cd server && go run ./cmd/sim $(ARGS)

sync-docs: ## docs/ -> Obsidian vault (односторонне, источник истины — репо)
	bash scripts/sync-docs-to-vault.sh
