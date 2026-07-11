# IT Director Web Game

Форк старой web-игры Intel «IT Manager 3: Unseen Forces» в pixel style.
Кликер про развитие IT-компании: офис, серверная, ПК, сотрудники, роутер
и серверы-мультипликаторы.

## Стек

- Сервер: Go — на каждое WebSocket-подключение своя игра и горутина-актор
  (тик 1 с). Без сохранений: разрыв соединения = новая игра.
- Клиент: Phaser 3 + TypeScript + Vite, кодогенерируемый пиксель-арт.

## Запуск (dev)

    make dev        # Go-сервер :8080 + Vite :5173 (открыть http://localhost:5173)

## Прод-сборка

    make build
    ./bin/itdirector -static client/dist   # всё на http://localhost:8080

## Тесты

    make test        # Go: домен и WebSocket-слой
    make typecheck   # клиент: проверка типов

## Документация

- Геймдизайн (живой): docs/design/gdd.md
- Спека итерации 1: docs/superpowers/specs/2026-07-11-it-director-mvp-design.md
