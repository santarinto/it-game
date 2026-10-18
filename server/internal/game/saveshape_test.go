package game

import (
	"reflect"
	"testing"

	"itdirector/internal/saveshape"
)

// Структура сейва закреплена (ITGAME-169, правило владельца 18.10): любое добавленное, убранное
// или изменённое поле Save — на любой глубине (Config, Office → Employee, DayEvent, DayLedger →
// LedgerEvent/LedgerPurchase): ключ, тип или опции json-тега — поднимает SaveFormat, миграций нет.
// Слепок — testdata/save_shape.txt; обходчик и вердикт — пакет saveshape, общие с
// TestSessionSaveShape в ws: тот держит остальной файл сейва — ws.sessionSave вокруг Save (ITGAME-175).
func TestSaveShape(t *testing.T) {
	saveshape.Pin{
		Root: reflect.TypeFor[Save](), Pkg: "server/internal/game", File: "testdata/save_shape.txt", Format: SaveFormat,
	}.Check(t)
}
