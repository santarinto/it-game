# IT Director

A pixel-art browser clicker about growing an IT company, inspired by Intel's
*IT Manager 3: Unseen Forces*. Buy PCs, hire staff, build the network
(routers → core switch → server racks → internet gateway), open new offices
and keep income ahead of payroll and running costs. Run out of money at the
end-of-day settlement and the company goes bankrupt.

Play: https://itgame.santarinto.com

## Tech stack

- **Server:** Go — one game actor per WebSocket connection, file-based
  session saves with reconnect and offline catch-up.
- **Client:** Phaser 3, TypeScript, Vite.
- **Protocol:** JSON over WebSocket.
- **Database:** PostgreSQL, optional (used only by the `/admin` page).

## Getting started

Requires Go 1.26, Node.js 22 and Chromium (the client build and UI tests use
it; set `CHROME_PATH` if it is not in a standard location).

    make dev        # Go server :8080 + Vite :5173 → http://localhost:5173
    make build      # then: ./bin/itdirector -static client/dist
    make test       # Go tests (DB tests need TEST_DATABASE_URL)
    make typecheck  # client type check
    make smoke-ui   # headless-browser smoke test of the built client

To enable `/admin`, put `DATABASE_URL=postgres://…` into `.env` in the repo
root.

Deploy, saves, testing, CI and the asset pipeline:
[`docs/development.md`](docs/development.md).

## License

[GNU Affero General Public License v3.0](LICENSE). Sound effects are
[Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) (CC0).
