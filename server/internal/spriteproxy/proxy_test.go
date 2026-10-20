package spriteproxy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const goToken = "go-token"

// fakeMinipc — заглушка API заданий minipc (MINIPC-231): задание 7 с ключом
// icon_trophy и двумя ревизиями; latest — вторая. lie подменяет заявленный
// sha256 у ревизии 2 — проверка sha_mismatch. Токен — только goToken.
type fakeMinipc struct {
	revs   map[string][]byte
	lie    bool
	noSha  bool // ревизия без X-Sprite-Sha256
	status int  // не 0 — minipc отвечает этим кодом на всё
	paths  []string
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func (f *fakeMinipc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.paths = append(f.paths, r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+goToken {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
		return
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		_, _ = io.WriteString(w, `{"error":"упал"}`)
		return
	}
	switch {
	case r.URL.Path == "/api/itgame/jobs/7":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"taskId":"7","about":"ITGAME-83","keys":[{"key":"icon_trophy","status":"draft","latest":{"rev":2}}]}`)
		return
	case strings.HasPrefix(r.URL.Path, "/api/itgame/jobs/7/keys/icon_trophy/"):
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"not found"}`)
		return
	}
	rev := strings.TrimPrefix(r.URL.Path, "/api/itgame/jobs/7/keys/icon_trophy/")
	if rev == "latest" {
		rev = "2"
	} else {
		rev = strings.TrimPrefix(rev, "revisions/")
	}
	png, ok := f.revs[rev]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"no such revision"}`)
		return
	}
	sha := sum(png)
	if f.lie && rev == "2" {
		sha = sum([]byte("другое"))
	}
	w.Header().Set("ETag", `"`+sha+`"`)
	if r.Header.Get("If-None-Match") == `"`+sha+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Sprite-Rev", rev)
	if !f.noSha {
		w.Header().Set("X-Sprite-Sha256", sha)
	}
	_, _ = w.Write(png)
}

func setup(t *testing.T, up Upstream) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	Register(mux, up)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newFake(t *testing.T) (*fakeMinipc, Upstream) {
	t.Helper()
	f := &fakeMinipc{revs: map[string][]byte{"1": []byte("png-1"), "2": []byte("png-2")}}
	up := httptest.NewServer(f)
	t.Cleanup(up.Close)
	return f, Upstream{URL: up.URL + "/api/itgame", Token: goToken}
}

func get(t *testing.T, url string, hdr ...string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, body
}

func wantCode(t *testing.T, resp *http.Response, body []byte, status int, code string) {
	t.Helper()
	var e struct{ Code, Error string }
	_ = json.Unmarshal(body, &e)
	if resp.StatusCode != status || e.Code != code {
		t.Fatalf("ответ %d %s, ожидался %d с code %q", resp.StatusCode, body, status, code)
	}
	if e.Error == "" {
		t.Fatalf("у отказа %q нет error — человеку нечего прочесть", code)
	}
}

func TestRevision(t *testing.T) {
	_, up := newFake(t)
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy?rev=1")
	if resp.StatusCode != http.StatusOK || string(body) != "png-1" {
		t.Fatalf("ревизия 1: %d %q", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type %q", ct)
	}
	if rev, sha := resp.Header.Get("X-Sprite-Rev"), resp.Header.Get("X-Sprite-Sha256"); rev != "1" || sha != sum([]byte("png-1")) {
		t.Fatalf("X-Sprite-Rev %q, X-Sprite-Sha256 %q", rev, sha)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
}

func TestLatestAndNotModified(t *testing.T) {
	_, up := newFake(t)
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy/latest")
	etag := resp.Header.Get("ETag")
	if resp.StatusCode != http.StatusOK || string(body) != "png-2" || etag != `"`+sum([]byte("png-2"))+`"` {
		t.Fatalf("latest: %d %q ETag %q", resp.StatusCode, body, etag)
	}
	if rev := resp.Header.Get("X-Sprite-Rev"); rev != "2" {
		t.Fatalf("X-Sprite-Rev %q", rev)
	}
	resp, body = get(t, srv.URL+"/api/debug/sprite/7/icon_trophy/latest", "If-None-Match", etag)
	if resp.StatusCode != http.StatusNotModified || len(body) != 0 {
		t.Fatalf("If-None-Match: %d %q, ожидался 304 без тела", resp.StatusCode, body)
	}
}

func TestJob(t *testing.T) {
	_, up := newFake(t)
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7")
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"icon_trophy"`)) {
		t.Fatalf("задание: %d %s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type %q", ct)
	}
}

// Сервер пересчитывает sha256 байт: не сошлось с заявленным — 502, PNG не отдаётся.
func TestShaMismatch(t *testing.T) {
	f, up := newFake(t)
	f.lie = true
	srv := setup(t, up)
	for _, path := range []string{"/api/debug/sprite/7/icon_trophy?rev=2", "/api/debug/sprite/7/icon_trophy/latest"} {
		resp, body := get(t, srv.URL+path)
		wantCode(t, resp, body, http.StatusBadGateway, "sha_mismatch")
	}
}

func TestNotConfigured(t *testing.T) {
	for _, up := range []Upstream{{}, {URL: "http://127.0.0.1:1/api/itgame"}, {Token: goToken}} {
		srv := setup(t, up)
		for _, path := range []string{"/api/debug/sprite/7", "/api/debug/sprite/7/icon_trophy?rev=1", "/api/debug/sprite/7/icon_trophy/latest"} {
			resp, body := get(t, srv.URL+path)
			wantCode(t, resp, body, http.StatusServiceUnavailable, "minipc_not_configured")
		}
	}
}

// Аргументы проверяются до minipc: в путь upstream не попадает ничего, кроме
// числа, ключа манифеста и номера ревизии.
func TestBadArgs(t *testing.T) {
	f, up := newFake(t)
	srv := setup(t, up)
	cases := []struct{ path, code string }{
		{"/api/debug/sprite/abc", "bad_task"},
		{"/api/debug/sprite/7/Icon-Trophy?rev=1", "bad_key"},
		{"/api/debug/sprite/7/icon_trophy", "bad_rev"},
		{"/api/debug/sprite/7/icon_trophy?rev=0", "bad_rev"},
		{"/api/debug/sprite/7/icon_trophy?rev=x", "bad_rev"},
		{"/api/debug/sprite/7/icon.trophy/latest", "bad_key"},
	}
	for _, c := range cases {
		resp, body := get(t, srv.URL+c.path)
		wantCode(t, resp, body, http.StatusBadRequest, c.code)
	}
	if len(f.paths) != 0 {
		t.Fatalf("до minipc дошли запросы %v", f.paths)
	}
}

func TestUpstreamErrors(t *testing.T) {
	_, up := newFake(t)
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy?rev=9")
	wantCode(t, resp, body, http.StatusNotFound, "not_found")
	resp, body = get(t, srv.URL+"/api/debug/sprite/8")
	wantCode(t, resp, body, http.StatusNotFound, "not_found")

	bad := setup(t, Upstream{URL: up.URL, Token: "чужой"})
	resp, body = get(t, bad.URL+"/api/debug/sprite/7")
	wantCode(t, resp, body, http.StatusBadGateway, "minipc_auth")

	down := setup(t, Upstream{URL: "http://127.0.0.1:1/api/itgame", Token: goToken})
	resp, body = get(t, down.URL+"/api/debug/sprite/7/icon_trophy/latest")
	wantCode(t, resp, body, http.StatusBadGateway, "minipc_unreachable")
}

// Без X-Sprite-Sha256 сверять не с чем — ревизия не отдаётся, как при расхождении.
func TestMissingSha(t *testing.T) {
	f, up := newFake(t)
	f.noSha = true
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy?rev=1")
	wantCode(t, resp, body, http.StatusBadGateway, "sha_mismatch")
}

func TestUpstream5xx(t *testing.T) {
	f, up := newFake(t)
	f.status = http.StatusInternalServerError
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy/latest")
	wantCode(t, resp, body, http.StatusBadGateway, "minipc_error")
	if !strings.Contains(string(body), "упал") {
		t.Fatalf("причина minipc потерялась: %s", body)
	}
}

func TestTooLarge(t *testing.T) {
	f, up := newFake(t)
	f.revs["1"] = bytes.Repeat([]byte{0}, maxPNG+1)
	srv := setup(t, up)
	resp, body := get(t, srv.URL+"/api/debug/sprite/7/icon_trophy?rev=1")
	wantCode(t, resp, body, http.StatusBadGateway, "too_large")
}
