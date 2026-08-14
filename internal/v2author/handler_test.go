package v2author

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"songs.exe.dev/internal/v2auth"
)

const (
	testOwner  = "owner@example.test"
	testHost   = "songs.test"
	testSource = "---\nschema_version: 1\nid: \"song-one\"\ntitle: \"Song One\"\nartist: \"The Band\"\n---\n\n# Song One\n\n### Verse 1\nLine one  \nLine two\n"
)

func fakeApex(t *testing.T, fail bool) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "apex")
	body := `#!/bin/sh
set -eu
[ "$1" = "--no-plugins" ]
[ "$2" = "--no-unsafe" ]
[ "$3" = "--aria" ]
[ "$4" = "--mode" ]
[ "$5" = "unified" ]
[ "$6" = "--to" ]
[ "$7" = "html" ]
grep -q '^# Song One$' "$8"
`
	if fail {
		body += "echo invalid >&2\nexit 2\n"
	} else {
		body += "printf '<article><h1>Song One</h1></article>'\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func newTestHandler(t *testing.T, mutate func(*Config)) *Handler {
	t.Helper()
	cfg := Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: fakeApex(t, false)}
	if mutate != nil {
		mutate(&cfg)
	}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func request(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:4321"
	r.Header.Set(v2auth.UserHeader, testOwner)
	r.Header.Set(v2auth.ForwardedHostHeader, testHost)
	r.Header.Set(v2auth.ForwardedProtoHeader, "https")
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func decodeObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, raw)
	}
	return object
}

func assertExactKeys(t *testing.T, object map[string]any, expected ...string) {
	t.Helper()
	want := make(map[string]bool, len(expected))
	for _, key := range expected {
		want[key] = true
	}
	if len(object) != len(want) {
		t.Fatalf("response keys=%v want=%v", mapKeys(object), expected)
	}
	for key := range object {
		if !want[key] {
			t.Fatalf("unexpected response key %q; keys=%v", key, mapKeys(object))
		}
	}
}

func mapKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func TestNewValidatesTrustedConfiguration(t *testing.T) {
	apex := fakeApex(t, false)
	for _, test := range []struct {
		name string
		cfg  Config
	}{
		{"owner", Config{ForwardedHost: testHost, ApexPath: apex}},
		{"host", Config{OwnerID: testOwner, ApexPath: apex}},
		{"apex", Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: filepath.Join(t.TempDir(), "missing")}},
		{"provider URLs", Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: apex, ProvidersEnabled: true}},
		{"model", Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: apex, ShelleyEnabled: true, LLMBaseURL: "https://llm.test"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.cfg); err == nil {
				t.Fatal("expected configuration error")
			}
		})
	}
}

func TestValidateRendersExactCandidateWithoutPublication(t *testing.T) {
	h := newTestHandler(t, nil)
	payload, _ := json.Marshal(map[string]string{"document_id": "song-one", "path": "songs/Song-One.md", "title": "Song One", "source": testSource})
	r := request(http.MethodPost, PathPrefix+"/validate", string(payload))
	r.Header.Set("Origin", "https://"+testHost)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	assertExactKeys(t, decodeObject(t, w.Body.Bytes()), "schema_version", "authority", "document_id", "path", "title", "source_sha256", "valid", "html", "issues")
	var out ValidationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Valid || out.Authority != "server-apex" || out.HTML != "<article><h1>Song One</h1></article>" || out.SourceSHA256 != sha256Hex(testSource) || len(out.Issues) != 0 {
		t.Fatalf("response=%#v", out)
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("cache=%q", got)
	}
}

func TestValidateRejectsUnsafeBoundaryAndStrictJSON(t *testing.T) {
	h := newTestHandler(t, nil)
	valid := fmt.Sprintf(`{"document_id":"song-one","path":"songs/Song-One.md","title":"Song One","source":%q}`, testSource)
	tests := []struct {
		name   string
		mutate func(*http.Request)
		body   string
		status int
		code   string
	}{
		{"unauthenticated", func(r *http.Request) { r.Header.Del(v2auth.UserHeader) }, valid, http.StatusUnauthorized, "UNAUTHENTICATED"},
		{"non-loopback", func(r *http.Request) { r.RemoteAddr = "203.0.113.2:1" }, valid, http.StatusUnauthorized, "UNAUTHENTICATED"},
		{"cross-origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, valid, http.StatusForbidden, "CROSS_SITE_REQUEST"},
		{"fetch metadata", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, valid, http.StatusForbidden, "CROSS_SITE_REQUEST"},
		{"unknown", nil, strings.TrimSuffix(valid, "}") + `,"extra":true}`, http.StatusBadRequest, "UNKNOWN_FIELD"},
		{"duplicate", nil, strings.TrimSuffix(valid, "}") + `,"title":"Again"}`, http.StatusBadRequest, "DUPLICATE_FIELD"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := request(http.MethodPost, PathPrefix+"/validate", test.body)
			if test.mutate != nil {
				test.mutate(r)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != test.status || !strings.Contains(w.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestRequestRoutingBoundsAndErrorResponseShape(t *testing.T) {
	h := newTestHandler(t, nil)
	valid := fmt.Sprintf(`{"document_id":"song-one","path":"songs/Song-One.md","title":"Song One","source":%q}`, testSource)
	tests := []struct {
		name   string
		method string
		path   string
		body   string
		mutate func(*http.Request)
		status int
		code   string
	}{
		{"not found", http.MethodGet, PathPrefix + "/missing", "", nil, http.StatusNotFound, "NOT_FOUND"},
		{"method", http.MethodGet, PathPrefix + "/validate", "", nil, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED"},
		{"query", http.MethodPost, PathPrefix + "/validate?unexpected=1", valid, nil, http.StatusBadRequest, "INVALID_QUERY"},
		{"content type", http.MethodPost, PathPrefix + "/validate", valid, func(r *http.Request) { r.Header.Del("Content-Type") }, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE"},
		{"body limit", http.MethodPost, PathPrefix + "/validate", strings.Repeat("x", maxRequestBytes+1), nil, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			r := request(test.method, test.path, test.body)
			if test.mutate != nil {
				test.mutate(r)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			outer := decodeObject(t, w.Body.Bytes())
			assertExactKeys(t, outer, "schema_version", "error")
			failure, ok := outer["error"].(map[string]any)
			if !ok {
				t.Fatalf("error=%#v", outer["error"])
			}
			assertExactKeys(t, failure, "code", "message")
			if failure["code"] != test.code {
				t.Fatalf("error code=%#v want=%q", failure["code"], test.code)
			}
		})
	}
}

func TestValidateBoundsConcurrentApexProcesses(t *testing.T) {
	dir := t.TempDir()
	gate := filepath.Join(dir, "gate")
	t.Cleanup(func() { _ = os.WriteFile(gate, []byte("release"), 0o600) })
	started := filepath.Join(dir, "started")
	if err := os.Mkdir(started, 0o700); err != nil {
		t.Fatal(err)
	}
	apex := filepath.Join(dir, "apex")
	script := "#!/bin/sh\nset -eu\ntouch " + shellQuote(started) + "/$$\nwhile [ ! -f " + shellQuote(gate) + " ]; do sleep 0.01; done\nprintf '<article>ok</article>'\n"
	if err := os.WriteFile(apex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	h, err := New(Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: apex})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"document_id": "song-one", "path": "songs/Song-One.md", "title": "Song One", "source": testSource})
	responses := make(chan int, 2)
	for range 2 {
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request(http.MethodPost, PathPrefix+"/validate", string(payload)))
			responses <- w.Code
		}()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		entries, readErr := os.ReadDir(started)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if len(entries) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("two Apex processes did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	third := httptest.NewRecorder()
	h.ServeHTTP(third, request(http.MethodPost, PathPrefix+"/validate", string(payload)))
	if third.Code != http.StatusTooManyRequests || !strings.Contains(third.Body.String(), "TOO_MANY_REQUESTS") {
		t.Fatalf("third status=%d body=%s", third.Code, third.Body.String())
	}
	if err := os.WriteFile(gate, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if status := <-responses; status != http.StatusOK {
			t.Fatalf("blocked validation status=%d", status)
		}
	}
}

func TestValidateLocalFailureDoesNotInvokeApex(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "apex-called")
	apex := fakeApex(t, false)
	wrapper := filepath.Join(t.TempDir(), "apex-wrapper")
	script := "#!/bin/sh\nprintf x > " + shellQuote(marker) + "\nexec " + shellQuote(apex) + " \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: wrapper}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	bad := strings.Replace(testSource, "artist: \"The Band\"\n", "", 1)
	payload, _ := json.Marshal(map[string]string{"document_id": "song-one", "path": "songs/Song-One.md", "title": "Song One", "source": bad})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request(http.MethodPost, PathPrefix+"/validate", string(payload)))
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "ARTIST_REQUIRED") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	invalidObject := decodeObject(t, w.Body.Bytes())
	assertExactKeys(t, invalidObject, "schema_version", "authority", "document_id", "path", "title", "source_sha256", "valid", "issues")
	if _, present := invalidObject["html"]; present {
		t.Fatal("invalid validation response included HTML")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("Apex ran for locally invalid source: %v", err)
	}
}

func TestApexFailureIsBoundedValidationFailure(t *testing.T) {
	h, err := New(Config{OwnerID: testOwner, ForwardedHost: testHost, ApexPath: fakeApex(t, true)})
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"document_id": "song-one", "path": "songs/Song-One.md", "title": "Song One", "source": testSource})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request(http.MethodPost, PathPrefix+"/validate", string(payload)))
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "APEX_VALIDATION_FAILED") || strings.Contains(w.Body.String(), "invalid") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func providerServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/search":
			fmt.Fprint(w, `[{"id":1,"trackName":"Rebel Yell","artistName":"Billy Idol","albumName":"Rebel Yell","duration":285,"plainLyrics":"must-not-leak"}]`)
		case strings.HasPrefix(r.URL.Path, "/suggest/"):
			fmt.Fprint(w, `{"data":[{"id":99,"title":"Rebel Yell","duration":285,"artist":{"name":"Billy Idol"},"album":{"title":"Rebel Yell"}}]}`)
		case r.URL.Path == "/api/get/1":
			fmt.Fprint(w, "{\"id\":1,\"trackName\":\"Rebel Yell\",\"artistName\":\"Billy Idol\",\"plainLyrics\":\"First line\\nSecond line\\n\\nSing it now\\nSing it loud\\nSing it proud\\n\\nOther line\\nAnother line\\n\\nSing it now\\nSing it loud\\nSing it proud\"}")
		case r.URL.Path == "/track/99":
			fmt.Fprint(w, `{"bpm":166.04}`)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestProviderSearchAndDeterministicFallbackImport(t *testing.T) {
	provider := providerServer(t)
	defer provider.Close()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "offline", http.StatusBadGateway) }))
	defer model.Close()
	h := newTestHandler(t, func(c *Config) {
		c.ProvidersEnabled = true
		c.ShelleyEnabled = true
		c.LRCLIBBaseURL = provider.URL
		c.LyricsOvhBaseURL = provider.URL
		c.DeezerBaseURL = provider.URL
		c.LLMBaseURL = model.URL
		c.LLMModel = "test-model"
	})
	search := request(http.MethodGet, PathPrefix+"/providers/search?title=Rebel+Yell&artist=Billy+Idol", "")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, search)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"provider":"LRCLIB"`) || strings.Contains(w.Body.String(), "must-not-leak") {
		t.Fatalf("search status=%d body=%s", w.Code, w.Body.String())
	}
	searchObject := decodeObject(t, w.Body.Bytes())
	assertExactKeys(t, searchObject, "schema_version", "choices", "provider_errors")
	choices, ok := searchObject["choices"].([]any)
	if !ok || len(choices) == 0 {
		t.Fatalf("search choices=%#v", searchObject["choices"])
	}
	first, ok := choices[0].(map[string]any)
	if !ok {
		t.Fatalf("first choice=%#v", choices[0])
	}
	assertExactKeys(t, first, "provider", "id", "title", "artist", "album", "duration")

	selection := `{"provider":"LRCLIB","id":"1","title":"Rebel Yell","artist":"Billy Idol"}`
	var sources []string
	for range 2 {
		r := request(http.MethodPost, PathPrefix+"/providers/import", selection)
		r.Header.Set("Origin", "https://"+testHost)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("import status=%d body=%s", w.Code, w.Body.String())
		}
		assertExactKeys(t, decodeObject(t, w.Body.Bytes()), "schema_version", "review_required", "title", "artist", "original_bpm", "source_provider", "source_url", "source", "source_sha256", "structured_by")
		var out ImportResponse
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if !out.ReviewRequired || out.OriginalBPM != "166.04" || out.StructuredBy != "deterministic-fallback" || !strings.Contains(out.Source, "provenance_status: \"provider-imported-pending-review\"") || !strings.Contains(out.Source, "### Chorus") {
			t.Fatalf("import=%#v", out)
		}
		sources = append(sources, out.Source)
	}
	if sources[0] != sources[1] {
		t.Fatal("fallback source was not deterministic")
	}
}

func TestProviderCapabilityDisabledAndQueryBounded(t *testing.T) {
	h := newTestHandler(t, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request(http.MethodGet, PathPrefix+"/providers/search?title=Hi", ""))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "CAPABILITY_DISABLED") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestShelleySuggestionReturnsValidatedExactCandidateAndBaseHash(t *testing.T) {
	revised := strings.Replace(testSource, "Line two", "Focused revised line", 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["store"] != false || payload["stream"] != false || payload["model"] != "test-model" {
			t.Errorf("unsafe model payload: %#v", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"output": []any{map[string]any{"content": []any{map[string]any{"type": "output_text", "text": revised}}}}})
	}))
	defer model.Close()
	h := newTestHandler(t, func(c *Config) { c.ShelleyEnabled = true; c.LLMBaseURL = model.URL; c.LLMModel = "test-model" })
	payload, _ := json.Marshal(map[string]string{"base_source_sha256": sha256Hex(testSource), "title": "Song One", "source": testSource, "prompt": "Change only the final lyric as requested."})
	r := request(http.MethodPost, PathPrefix+"/shelley/suggest", string(payload))
	r.Header.Set("Origin", "https://"+testHost)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	assertExactKeys(t, decodeObject(t, w.Body.Bytes()), "schema_version", "review_required", "base_source_sha256", "source", "source_sha256", "model")
	var out SuggestResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Source != revised || out.BaseSourceSHA256 != sha256Hex(testSource) || out.SourceSHA256 != sha256Hex(revised) || !out.ReviewRequired {
		t.Fatalf("response=%#v", out)
	}
}

func TestShelleyRejectsHashMismatchAndInvalidModelIdentity(t *testing.T) {
	changedIdentity := strings.Replace(testSource, `id: "song-one"`, `id: "song-two"`, 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		event, _ := json.Marshal(map[string]string{"type": "response.output_text.delta", "delta": changedIdentity})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", event)
	}))
	defer model.Close()
	h := newTestHandler(t, func(c *Config) { c.ShelleyEnabled = true; c.LLMBaseURL = model.URL; c.LLMModel = "test-model" })
	for _, test := range []struct {
		name, hash string
		status     int
		code       string
	}{{"hash", strings.Repeat("0", 64), http.StatusBadRequest, "BASE_HASH_MISMATCH"}, {"identity", sha256Hex(testSource), http.StatusBadGateway, "INVALID_MODEL_RESPONSE"}} {
		t.Run(test.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]string{"base_source_sha256": test.hash, "title": "Song One", "source": testSource, "prompt": "Make a focused safe edit"})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request(http.MethodPost, PathPrefix+"/shelley/suggest", string(payload)))
			if w.Code != test.status || !strings.Contains(w.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestConfiguredClientTimeoutBoundsProviderCalls(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(200 * time.Millisecond); fmt.Fprint(w, `[]`) }))
	defer provider.Close()
	h := newTestHandler(t, func(c *Config) {
		c.ProvidersEnabled = true
		c.LRCLIBBaseURL = provider.URL
		c.LyricsOvhBaseURL = provider.URL
		c.DeezerBaseURL = provider.URL
		c.HTTPClient = &http.Client{Timeout: 20 * time.Millisecond}
	})
	started := time.Now()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request(http.MethodGet, PathPrefix+"/providers/search?title=Song", ""))
	if time.Since(started) > 150*time.Millisecond {
		t.Fatal("provider request was not bounded by configured timeout")
	}
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
