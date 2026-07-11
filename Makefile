.PHONY: dev dev-server dev-client test typecheck build

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

build:
	cd client && npm run build
	cd server && go build -o ../bin/itdirector ./cmd/server
