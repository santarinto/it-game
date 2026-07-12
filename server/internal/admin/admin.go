// Package admin — служебная страница: конфигурация игры и справочники БД.
package admin

import (
	_ "embed"
	"fmt"
	"html/template"
	"net/http"

	"itdirector/internal/db"
	"itdirector/internal/game"
)

//go:embed page.html
var pageHTML string

var page = template.Must(template.New("admin").Parse(pageHTML))

// Handler отдаёт страницу админки. DB может быть nil — тогда каталог
// заменяется сообщением «БД недоступна».
type Handler struct {
	Config game.Config
	DB     *db.DB
}

type row struct {
	Label string
	Value any
}

type pageData struct {
	ConfigRows []row
	Equipment  []db.Equipment
	DBError    string
}

// configRows — явный маппинг конфига с русскими подписями.
// Reflection не используем: подписи важнее автоматики.
func configRows(c game.Config) []row {
	rows := []row{
		{"Стартовые деньги", c.StartMoney},
		{"Стартовые ПК", c.StartPCs},
		{"Слотов офиса", c.OfficeSlots},
		{"Потолок штата без начальника", c.StaffLimit},
		{"Стоек серверной", c.RackSlots},
		{"Цена ПК", c.PCPrice},
		{"Цена найма", c.HirePrice},
		{"Цена сервера", c.ServerPrice},
		{"Выработка сотрудника, $/тик", fmt.Sprintf("%d–%d", c.IncomeMin, c.IncomeMax)},
		{"База множителя сети", c.NetworkBase},
		{"Бонус за сервер", c.ServerBonus},
		{"Тиков в часе", c.TicksPerHour},
		{"Рабочий день", fmt.Sprintf("%02d:00–%02d:00", c.WorkdayStart, c.WorkdayEnd)},
		{"Обед", fmt.Sprintf("%02d:00–%02d:00", c.LunchStart, c.LunchEnd)},
		{"Зарплата сотрудника", c.SalaryPerDay},
		{"Найм начальника", c.BossPrice},
		{"Зарплата начальника", c.BossSalaryPerDay},
		{"Цены офисов 2–3", fmt.Sprintf("%v", c.OfficePrices)},
		{"Шлюз: цена", c.GatewayPrice},
		{"Шлюз: опекс в день", c.GatewayOpexPerDay},
		{"Шлюз: множитель", c.GatewayBonus},
		{"Кулер", c.CoolerPrice},
		{"Холодильник", c.FridgePrice},
		{"Кофеварка", c.CoffeeMachinePrice},
	}
	for i, t := range c.RouterTiers {
		rows = append(rows, row{fmt.Sprintf("Роутер тир %d", i+1), fmt.Sprintf("$%d, портов: %d", t.Price, t.Ports)})
	}
	return rows
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	data := pageData{ConfigRows: configRows(h.Config)}
	if h.DB == nil {
		data.DBError = "DATABASE_URL не задан"
	} else {
		items, err := h.DB.ListEquipment(r.Context())
		if err != nil {
			data.DBError = err.Error()
		} else {
			data.Equipment = items
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := page.Execute(w, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
