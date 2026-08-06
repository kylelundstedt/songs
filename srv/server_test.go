package srv

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureServer(t *testing.T) *Server {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "songs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "songs", "Test-Song.md"), []byte("# Test Song\n\n### Verse\nOne line  \nTwo lines\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	set := "---\ntitle: Test Set\ndate: 2026-08-06\nlocation: Test Room\n---\n\n# Test Set\n\n1. [Test Song](../songs/Test-Song.md)\n"
	if err := os.WriteFile(filepath.Join(root, "sets", "test-set.md"), []byte(set), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-b", "main"}, {"config", "user.name", "Test"}, {"config", "user.email", "test@example.invalid"}, {"add", "."}, {"commit", "-m", "fixture"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	server, err := New(filepath.Join(root, "test.sqlite3"), "test-host", root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.DB.Close() })
	return server
}

func TestCatalogAndRoutes(t *testing.T) {
	server := fixtureServer(t)
	if len(server.songs) != 1 || server.songs[0].Title != "Test Song" {
		t.Fatalf("songs=%#v", server.songs)
	}
	if len(server.sets) != 1 || len(server.sets[0].Items) != 1 {
		t.Fatalf("sets=%#v", server.sets)
	}

	tests := []struct {
		name, path string
		handler    http.HandlerFunc
		contains   string
	}{
		{"home", "/", server.HandleHome, "Test Song"},
		{"song", "/song/test-song", server.HandleSong, "Two lines"},
		{"set", "/sets/test-set", server.HandleSet, "Open live set"},
		{"live", "/sets/test-set/live", server.HandleLiveSet, "data-live-panel"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if strings.Contains(tt.path, "/song/") {
				req.SetPathValue("id", "test-song")
			}
			if strings.Contains(tt.path, "/sets/") {
				req.SetPathValue("id", "test-set")
			}
			w := httptest.NewRecorder()
			tt.handler(w, req)
			if w.Code != 200 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), tt.contains) {
				t.Fatalf("body missing %q", tt.contains)
			}
		})
	}
}

func TestCreateSongWorkflow(t *testing.T) {
	server := fixtureServer(t)
	form := url.Values{
		"title":      {"Brand New Song"},
		"artist":     {"Example Artist"},
		"key":        {"A"},
		"source_url": {"https://example.com/song"},
		"body":       {"# Brand New Song\n\n### Verse 1\nDraft line"},
	}
	req := httptest.NewRequest(http.MethodPost, "/songs", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-ExeDev-UserID", "test-user")
	w := httptest.NewRecorder()
	server.HandleCreateSong(w, req)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Location"); got != "/song/brand-new-song" {
		t.Fatalf("redirect=%q", got)
	}
	body, err := os.ReadFile(filepath.Join(server.RepoRoot, "songs", "brand-new-song.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "source_url: \"https://example.com/song\"") {
		t.Fatalf("unexpected markdown: %s", body)
	}
	if len(server.songs) != 2 {
		t.Fatalf("indexed songs=%d", len(server.songs))
	}
}

func TestHelpers(t *testing.T) {
	if got := titleFromMarkdown("# Hello {short=\"Hi\"}\n"); got != "Hello" {
		t.Fatalf("title=%q", got)
	}
	if got := slugify("Can’t Stop!"); got != "can-t-stop" {
		t.Fatalf("slug=%q", got)
	}
	if got := metadataValue("---\ntitle: Demo\n---\n# Demo\n", "title"); got != "Demo" {
		t.Fatalf("metadata=%q", got)
	}
}
