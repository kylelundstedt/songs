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
	song := "---\nartist: Example Artist\nperformance_key: A\nbpm: 124\noriginal_key: G\noriginal_bpm: 118\nsource_provider: LRCLIB\nsource_url: https://lrclib.net/api/get/1\n---\n\n# Test Song\n\n### Verse 16X\nOne line  \nTwo lines\n"
	if err := os.WriteFile(filepath.Join(root, "songs", "Test-Song.md"), []byte(song), 0o644); err != nil {
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
	if song := server.songs[0]; song.Artist != "Example Artist" || song.Key != "A" || song.BPM != "124" || song.OriginalKey != "G" || song.OriginalBPM != "118" || song.SourceProvider != "LRCLIB" {
		t.Fatalf("song metadata=%#v", song)
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
		"title":            {"Brand New Song"},
		"artist":           {"Example Artist"},
		"key":              {"A"},
		"bpm":              {"128"},
		"original_key":     {"Bm"},
		"original_bpm":     {"166.04"},
		"source_provider":  {"LRCLIB"},
		"source_url":       {"https://example.com/song"},
		"rights_confirmed": {"yes"},
		"body":             {"# Brand New Song\n\n### Verse 1\nDraft line"},
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
	if !strings.Contains(string(body), "source_url: \"https://example.com/song\"") || !strings.Contains(string(body), "source_provider: \"LRCLIB\"") || !strings.Contains(string(body), "provenance_status: provider-imported-pending-review") || !strings.Contains(string(body), "original_key: \"Bm\"") || !strings.Contains(string(body), "original_bpm: \"166.04\"") || !strings.Contains(string(body), "bpm: \"128\"") {
		t.Fatalf("unexpected markdown: %s", body)
	}
	if len(server.songs) != 2 {
		t.Fatalf("indexed songs=%d", len(server.songs))
	}
}

func TestLyricsProviderWorkflow(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/search":
			_, _ = w.Write([]byte(`[{"id":1,"trackName":"Rebel Yell","artistName":"Billy Idol","albumName":"Rebel Yell","duration":285,"plainLyrics":"not returned to browser"}]`))
		case r.URL.Path == "/api/get/1":
			_, _ = w.Write([]byte(`{"id":1,"trackName":"Rebel Yell","artistName":"Billy Idol","plainLyrics":"Verse line one\nVerse line two\n\nRepeated line\nRepeated line two\nRepeated line three\n\nOther verse\nOther line\n\nRepeated line\nRepeated line two\nRepeated line three"}`))
		case strings.HasPrefix(r.URL.Path, "/suggest/"):
			_, _ = w.Write([]byte(`{"data":[{"id":99,"title":"Rebel Yell","duration":285,"artist":{"name":"Billy Idol"},"album":{"title":"Rebel Yell"}}]}`))
		case r.URL.Path == "/track/99":
			_, _ = w.Write([]byte(`{"bpm":166.04}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	server := fixtureServer(t)
	server.LRCLIBBaseURL = provider.URL
	server.LyricsOvhURL = provider.URL
	server.DeezerBaseURL = provider.URL

	searchReq := httptest.NewRequest(http.MethodGet, "/api/lyrics/search?q=Rebel+Yell", nil)
	searchReq.Header.Set("X-ExeDev-UserID", "test-user")
	searchW := httptest.NewRecorder()
	server.HandleLyricsSearch(searchW, searchReq)
	if searchW.Code != http.StatusOK || !strings.Contains(searchW.Body.String(), `"provider":"LRCLIB"`) || strings.Contains(searchW.Body.String(), "not returned to browser") {
		t.Fatalf("search status=%d body=%s", searchW.Code, searchW.Body.String())
	}

	selection := `{"provider":"LRCLIB","id":"1","title":"Rebel Yell","artist":"Billy Idol"}`
	importReq := httptest.NewRequest(http.MethodPost, "/api/lyrics/import", strings.NewReader(selection))
	importReq.Header.Set("X-ExeDev-UserID", "test-user")
	importW := httptest.NewRecorder()
	server.HandleLyricsImport(importW, importReq)
	if importW.Code != http.StatusOK {
		t.Fatalf("import status=%d body=%s", importW.Code, importW.Body.String())
	}
	if body := importW.Body.String(); !strings.Contains(body, `"original_bpm":"166.04"`) || !strings.Contains(body, "### Chorus") || !strings.Contains(body, `"source_provider":"LRCLIB"`) {
		t.Fatalf("unexpected draft: %s", body)
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
	if got := shelleyNewConversationURL("kgl-songs.exe.xyz"); got != "https://kgl-songs.shelley.exe.xyz/new" {
		t.Fatalf("shelley URL=%q", got)
	}
	body := preserveLeadSheetLineBreaks("# Demo\n\nFirst line\nSecond line\n\n### Chorus\nThird line\nFourth line")
	if !strings.Contains(body, "First line  \nSecond line") || !strings.Contains(body, "Third line  \nFourth line") {
		t.Fatalf("line breaks not preserved: %q", body)
	}
}
