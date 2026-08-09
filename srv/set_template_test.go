package srv

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetOmitsEmptyDetailRows(t *testing.T) {
	server := fixtureServer(t)
	setPath := filepath.Join(server.RepoRoot, "sets", "test-set.md")
	body := "---\ntitle: Test Set\nstatus: draft\n---\n\n# Test Set\n\n1. [Test Song](../songs/Test-Song.md)\n2. [Test Song](../songs/Test-Song.md) — note: Count in\n"
	if err := os.WriteFile(setPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := server.Reindex(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sets/test-set", nil)
	req.SetPathValue("id", "test-set")
	w := httptest.NewRecorder()
	server.HandleSet(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	response := w.Body.String()
	if strings.Contains(response, ">Draft<") || strings.Contains(response, "· Draft") {
		t.Fatal("set list rendered the retired Draft label")
	}
	if strings.Contains(response, "<small>—</small>") {
		t.Fatal("set list rendered a redundant empty detail row")
	}
	if !strings.Contains(response, "<small>Count in</small>") {
		t.Fatal("set list omitted a real item note")
	}
}
