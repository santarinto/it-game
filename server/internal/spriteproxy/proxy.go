// Package spriteproxy — ручки конвейера спрайтов на стороне игры (ITGAME-157,
// docs/design/sprite-pipeline.md, «Go-сервер»): вкладка с ?debug=1 берёт
// ревизию спрайта из API заданий minipc через Go-сервер игры, а не напрямую —
// токен остаётся на сервере, а сервер сверяет sha256 байт с заявленным.
// Регистрируются только под ITGAME_DEBUG=1 (main.go).
package spriteproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Upstream — адрес API заданий minipc (…/api/itgame) и токен роли itgame-go
// (только чтение). Пустое поле — ручки отвечают 503 minipc_not_configured.
type Upstream struct {
	URL   string
	Token string
}

// FromEnv — ITGAME_MINIPC_URL и ITGAME_MINIPC_TOKEN.
func FromEnv() Upstream {
	return Upstream{URL: os.Getenv("ITGAME_MINIPC_URL"), Token: os.Getenv("ITGAME_MINIPC_TOKEN")}
}

func (u Upstream) configured() bool { return u.URL != "" && u.Token != "" }

const (
	maxPNG = 8 << 20 // ревизия больше — не спрайт
	maxJob = 2 << 20 // задание с кропами контекста
)

var (
	taskRe = regexp.MustCompile(`^[0-9]+$`)
	keyRe  = regexp.MustCompile(`^[a-z0-9_]+$`)
	revRe  = regexp.MustCompile(`^[1-9][0-9]*$`)
)

type proxy struct {
	up     Upstream
	client *http.Client
}

// Register вешает ручки на mux:
//
//	GET /api/debug/sprite/{taskId}              — задание: ключи, статусы, latest/final
//	GET /api/debug/sprite/{taskId}/{key}?rev=N  — PNG ревизии N
//	GET /api/debug/sprite/{taskId}/{key}/latest — PNG последней ревизии, ETag/304
func Register(mux *http.ServeMux, up Upstream) {
	p := &proxy{up: up, client: &http.Client{Timeout: 10 * time.Second}}
	mux.HandleFunc("GET /api/debug/sprite/{taskId}", p.job)
	mux.HandleFunc("GET /api/debug/sprite/{taskId}/{key}", p.revision)
	mux.HandleFunc("GET /api/debug/sprite/{taskId}/{key}/latest", p.latest)
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "error": msg})
}

// args проверяет taskId и key до запроса в minipc: в путь upstream попадают
// только число и ключ манифеста.
func (p *proxy) args(w http.ResponseWriter, r *http.Request, withKey bool) (task, key string, ok bool) {
	if !p.up.configured() {
		fail(w, http.StatusServiceUnavailable, "minipc_not_configured", "ITGAME_MINIPC_URL и ITGAME_MINIPC_TOKEN не заданы — сервер не знает minipc")
		return "", "", false
	}
	task = r.PathValue("taskId")
	if !taskRe.MatchString(task) {
		fail(w, http.StatusBadRequest, "bad_task", fmt.Sprintf("taskId — число, получено %q", task))
		return "", "", false
	}
	if withKey {
		key = r.PathValue("key")
		if !keyRe.MatchString(key) {
			fail(w, http.StatusBadRequest, "bad_key", fmt.Sprintf("key — [a-z0-9_]+, получено %q", key))
			return "", "", false
		}
	}
	return task, key, true
}

func (p *proxy) job(w http.ResponseWriter, r *http.Request) {
	task, _, ok := p.args(w, r, false)
	if !ok {
		return
	}
	resp, body, ok := p.fetch(w, r, maxJob, "", "jobs", task)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

func (p *proxy) revision(w http.ResponseWriter, r *http.Request) {
	task, key, ok := p.args(w, r, true)
	if !ok {
		return
	}
	rev := r.URL.Query().Get("rev")
	if !revRe.MatchString(rev) {
		fail(w, http.StatusBadRequest, "bad_rev", fmt.Sprintf("rev — номер ревизии ≥ 1, получено %q; последняя — …/latest", rev))
		return
	}
	p.png(w, r, "", "jobs", task, "keys", key, "revisions", rev)
}

func (p *proxy) latest(w http.ResponseWriter, r *http.Request) {
	task, key, ok := p.args(w, r, true)
	if !ok {
		return
	}
	p.png(w, r, r.Header.Get("If-None-Match"), "jobs", task, "keys", key, "latest")
}

// png отдаёт ревизию, только если sha256 байт совпал с заявленным minipc.
func (p *proxy) png(w http.ResponseWriter, r *http.Request, ifNoneMatch string, path ...string) {
	resp, body, ok := p.fetch(w, r, maxPNG, ifNoneMatch, path...)
	if !ok {
		return
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}
	w.Header().Set("Cache-Control", "no-store")
	if resp.StatusCode == http.StatusNotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	claimed := strings.ToLower(resp.Header.Get("X-Sprite-Sha256"))
	h := sha256.Sum256(body)
	if got := hex.EncodeToString(h[:]); got != claimed {
		fail(w, http.StatusBadGateway, "sha_mismatch", fmt.Sprintf("sha256 байт %s, minipc заявил %q — ревизия не отдаётся", got, claimed))
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Sprite-Rev", resp.Header.Get("X-Sprite-Rev"))
	w.Header().Set("X-Sprite-Sha256", claimed)
	_, _ = w.Write(body)
}

// fetch — GET в minipc. Ответ, отличный от 200 и 304, уже записан в w кодом
// отказа: 404 с JSON {error} — not_found, 401/403 — minipc_auth, сеть —
// minipc_unreachable. 404 не JSON — страница фреймворка minipc: такой ручки нет
// (ITGAME_MINIPC_URL без /api/itgame), это minipc_error, а не not_found — иначе
// watch принял бы неверный адрес за «ревизий ещё нет» и молчал (ITGAME-182).
func (p *proxy) fetch(w http.ResponseWriter, r *http.Request, limit int64, ifNoneMatch string, path ...string) (*http.Response, []byte, bool) {
	target, err := url.JoinPath(p.up.URL, path...)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "minipc_not_configured", fmt.Sprintf("ITGAME_MINIPC_URL не URL: %v", err))
		return nil, nil, false
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "minipc_not_configured", fmt.Sprintf("ITGAME_MINIPC_URL не URL: %v", err))
		return nil, nil, false
	}
	req.Header.Set("Authorization", "Bearer "+p.up.Token)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		fail(w, http.StatusBadGateway, "minipc_unreachable", fmt.Sprintf("minipc не ответил: %v", err))
		return nil, nil, false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		fail(w, http.StatusBadGateway, "minipc_unreachable", fmt.Sprintf("ответ minipc оборвался: %v", err))
		return nil, nil, false
	}
	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNotModified:
		if int64(len(body)) > limit {
			fail(w, http.StatusBadGateway, "too_large", fmt.Sprintf("ответ minipc больше %d байт", limit))
			return nil, nil, false
		}
		return resp, body, true
	case resp.StatusCode == http.StatusNotFound && !machineError(body):
		fail(w, http.StatusBadGateway, "minipc_error", "minipc ответил 404 не JSON — такой ручки нет, проверьте ITGAME_MINIPC_URL (…/api/itgame)")
	case resp.StatusCode == http.StatusNotFound:
		fail(w, http.StatusNotFound, "not_found", "minipc: "+upstreamError(body, "нет такого задания, ключа или ревизии"))
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		fail(w, http.StatusBadGateway, "minipc_auth", fmt.Sprintf("minipc отказал токену сервера (%d): %s", resp.StatusCode, upstreamError(body, "проверьте ITGAME_MINIPC_TOKEN")))
	default:
		fail(w, http.StatusBadGateway, "minipc_error", fmt.Sprintf("minipc ответил %d: %s", resp.StatusCode, upstreamError(body, "без описания")))
	}
	return nil, nil, false
}

// minipcError — машинный ответ minipc: {error, field?}, у отказа роли (403) ещё
// detail (сверено 20.10, ITGAME-182).
type minipcError struct {
	Error  string `json:"error"`
	Field  string `json:"field"`
	Detail string `json:"detail"`
}

// machineError — тело это машинный отказ minipc, а не страница фреймворка.
func machineError(body []byte) bool {
	var e minipcError
	return json.Unmarshal(body, &e) == nil && e.Error != ""
}

// upstreamError — текст машинного ответа minipc: error, (field), — detail.
func upstreamError(body []byte, fallback string) string {
	var e minipcError
	if err := json.Unmarshal(body, &e); err != nil || e.Error == "" {
		return fallback
	}
	out := e.Error
	if e.Field != "" {
		out += " (" + e.Field + ")"
	}
	if e.Detail != "" {
		out += " — " + e.Detail
	}
	return out
}
