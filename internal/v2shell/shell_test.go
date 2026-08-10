package v2shell

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

func fixtureAPI() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"schema_version":"1","error":{"code":"NOT_FOUND","message":"fixture"}}`))
	})
}

func embeddedFiles(t *testing.T) fstest.MapFS {
	t.Helper()
	output := fstest.MapFS{}
	if err := fs.WalkDir(embedded, "data", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := fs.ReadFile(embedded, path)
		if err != nil {
			return err
		}
		output[path] = &fstest.MapFile{Data: bytes.Clone(raw), Mode: 0o444}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return output
}

func TestLoadAndServeReviewedShell(t *testing.T) {
	shell, err := LoadEmbedded(fixtureAPI(), expectedBootstrapSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if shell.Release() != expectedRelease {
		t.Fatalf("release=%s", shell.Release())
	}
	handler := shell.Handler()

	request := func(method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	root := request(http.MethodGet, "/")
	if root.Code != http.StatusOK || !bytes.Equal(root.Body.Bytes(), shell.assets["/index.html"].body) || root.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("root response=%d headers=%v", root.Code, root.Header())
	}
	sw := request(http.MethodGet, "/sw.js")
	if sw.Code != http.StatusOK || sw.Header().Get("Service-Worker-Allowed") != "/" || !bytes.Contains(sw.Body.Bytes(), []byte("songs-v2-shell-")) || bytes.Contains(sw.Body.Bytes(), []byte("songs-shell-v28")) {
		t.Fatalf("service worker response=%d", sw.Code)
	}
	unknown := request(http.MethodGet, "/not-a-shell-route")
	if unknown.Code != http.StatusNotFound || bytes.Contains(unknown.Body.Bytes(), []byte("<div id=\"root\"")) {
		t.Fatalf("unknown shell route fell through: %d", unknown.Code)
	}
	api := request(http.MethodGet, "/api/v2/not-found")
	if api.Code != http.StatusNotFound || api.Header().Get("Content-Type") != "application/json; charset=utf-8" || bytes.Contains(api.Body.Bytes(), []byte("<html")) {
		t.Fatalf("API boundary escaped: %d %s", api.Code, api.Body.String())
	}
	method := request(http.MethodPost, "/")
	if method.Code != http.StatusMethodNotAllowed || method.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("method response=%d", method.Code)
	}
}

func TestShellTrustAnchorRejectsTampering(t *testing.T) {
	files := embeddedFiles(t)
	raw := bytes.Clone(files["data/asset-manifest.json"].Data)
	raw[len(raw)/2] ^= 1
	files["data/asset-manifest.json"].Data = raw
	if _, err := Load(files, fixtureAPI(), expectedBootstrapSHA256); err == nil {
		t.Fatal("tampered asset manifest accepted")
	}
	if _, err := Load(embedded, fixtureAPI(), "wrong-bootstrap"); err == nil {
		t.Fatal("wrong bootstrap trust anchor accepted")
	}
}

type countingFS struct {
	fs.FS
	mu    sync.Mutex
	reads int
}

func (c *countingFS) Open(name string) (fs.File, error) {
	c.mu.Lock()
	c.reads++
	c.mu.Unlock()
	return c.FS.Open(name)
}
func (c *countingFS) count() int { c.mu.Lock(); defer c.mu.Unlock(); return c.reads }

func TestShellRequestsUseOnlyPreloadedBytes(t *testing.T) {
	files := &countingFS{FS: embeddedFiles(t)}
	shell, err := Load(files, fixtureAPI(), expectedBootstrapSHA256)
	if err != nil {
		t.Fatal(err)
	}
	reads := files.count()
	paths := []string{"/", "/manifest.webmanifest", "/sw.js"}
	for path := range shell.assets {
		if strings.HasSuffix(path, ".js") && strings.HasPrefix(path, "/assets/") {
			paths = append(paths, path)
			break
		}
	}
	for _, path := range paths {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		shell.Handler().ServeHTTP(httptest.NewRecorder(), request)
	}
	if files.count() != reads {
		t.Fatalf("request path read filesystem: before=%d after=%d", reads, files.count())
	}
}
