package game

import "testing"

func TestNewGameStart(t *testing.T) {
	g := New(DefaultConfig())
	if g.Money != 600 {
		t.Errorf("Money = %d, хотим 600", g.Money)
	}
	if g.PCs != 1 {
		t.Errorf("PCs = %d, хотим 1 (стартовый ПК)", g.PCs)
	}
	if g.Employees != 0 || g.RouterTier != 0 || g.Servers != 0 {
		t.Errorf("на старте не должно быть сотрудников, роутера и серверов: %+v", g)
	}
}
