package ws

import (
	"reflect"
	"testing"

	"itdirector/internal/game"
	"itdirector/internal/saveshape"
)

// Файл сейва — sessionSave целиком, не только game.Save (ITGAME-175): sid, скорость, время, отчёт
// дня (lastReport → game.DayReport, пишется в каждый сейв после дня 1), сценарий, журнал, rev,
// версия. Переименованное поле читается нулём, сменившее тип роняет json.Unmarshal в resume —
// партия начинается заново без карточки, поэтому любое добавленное, убранное или изменённое поле
// поднимает game.SaveFormat, как поле Save. Слепок — testdata/session_save_shape.txt; game.Save в
// нём — одна строка «game game.Save»: его держит свой слепок (TestSaveShape в game), обходчик и
// вердикт общие (saveshape).
func TestSessionSaveShape(t *testing.T) {
	saveshape.Pin{
		Root: reflect.TypeFor[sessionSave](), Pkg: "server/internal/ws", File: "testdata/session_save_shape.txt",
		Format: game.SaveFormat, Skip: []reflect.Type{reflect.TypeFor[game.Save]()},
	}.Check(t)
}
