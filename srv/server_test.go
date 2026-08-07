package srv

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	remote := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "--bare", remote).CombinedOutput(); err != nil {
		t.Fatalf("init remote: %v: %s", err, out)
	}
	for _, args := range [][]string{{"remote", "add", "origin", remote}, {"push", "-u", "origin", "main"}} {
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
	server.LLMBaseURL = ""
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
		{"about", "/about", server.HandleAbout, "Built for the stage"},
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

func TestMetadataPlaceholdersRemainVisible(t *testing.T) {
	server := fixtureServer(t)
	song := server.songs[0]
	song.Artist = ""
	song.Key = ""
	song.BPM = ""
	song.OriginalKey = ""
	song.OriginalBPM = ""
	song.SourceURL = ""
	song.SourceProvider = ""

	tests := []struct {
		path    string
		handler http.HandlerFunc
		id      string
	}{
		{path: "/song/test-song", handler: server.HandleSong, id: "test-song"},
		{path: "/sets/test-set/live", handler: server.HandleLiveSet, id: "test-set"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req.SetPathValue("id", tt.id)
			w := httptest.NewRecorder()
			tt.handler(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			body := w.Body.String()
			for _, field := range []string{"Key", "BPM", "Artist", "Lyrics", "Original key", "Original BPM"} {
				want := "<dt>" + field + "</dt><dd>—</dd>"
				if !strings.Contains(body, want) {
					t.Errorf("body missing visible placeholder %q", want)
				}
			}
		})
	}
}

func TestCreateSongWorkflow(t *testing.T) {
	server := fixtureServer(t)
	form := url.Values{
		"title":           {"Brand New Song"},
		"artist":          {"Example Artist"},
		"original_key":    {"Bm"},
		"original_bpm":    {"166.04"},
		"source_provider": {"LRCLIB"},
		"source_url":      {"https://example.com/song"},
		"body":            {"# Brand New Song\n\n### Verse 1\nDraft line"},
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
	if !strings.Contains(string(body), "source_url: \"https://example.com/song\"") || !strings.Contains(string(body), "source_provider: \"LRCLIB\"") || !strings.Contains(string(body), "provenance_status: provider-imported-pending-review") || !strings.Contains(string(body), "performance_key: \"Bm\"") || !strings.Contains(string(body), "original_key: \"Bm\"") || !strings.Contains(string(body), "original_bpm: \"166.04\"") || !strings.Contains(string(body), "bpm: \"166.04\"") {
		t.Fatalf("unexpected markdown: %s", body)
	}
	if len(server.songs) != 2 {
		t.Fatalf("indexed songs=%d", len(server.songs))
	}
}

func TestDirectMarkdownEditWorkflow(t *testing.T) {
	server := fixtureServer(t)
	get := httptest.NewRequest(http.MethodGet, "/api/songs/test-song/markdown", nil)
	get.SetPathValue("id", "test-song")
	get.Header.Set("X-ExeDev-UserID", "test-user")
	getW := httptest.NewRecorder()
	server.HandleSongMarkdown(getW, get)
	if getW.Code != http.StatusOK || getW.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("get status=%d cache=%q body=%s", getW.Code, getW.Header().Get("Cache-Control"), getW.Body.String())
	}
	var source struct {
		Markdown string `json:"markdown"`
		Hash     string `json:"hash"`
	}
	if err := json.Unmarshal(getW.Body.Bytes(), &source); err != nil || source.Hash == "" {
		t.Fatalf("source=%#v err=%v", source, err)
	}
	revised := strings.Replace(source.Markdown, "### Verse 16X", "### Verse 14x", 1)
	payload, _ := json.Marshal(markdownUpdateRequest{Markdown: revised, ExpectedHash: source.Hash})
	put := httptest.NewRequest(http.MethodPut, "/api/songs/test-song/markdown", strings.NewReader(string(payload)))
	put.SetPathValue("id", "test-song")
	put.Header.Set("X-ExeDev-UserID", "test-user")
	put.Header.Set("Content-Type", "application/json")
	putW := httptest.NewRecorder()
	server.HandleUpdateSongMarkdown(putW, put)
	if putW.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", putW.Code, putW.Body.String())
	}
	body, err := os.ReadFile(filepath.Join(server.RepoRoot, "songs", "Test-Song.md"))
	info, statErr := os.Stat(filepath.Join(server.RepoRoot, "songs", "Test-Song.md"))
	if err != nil || statErr != nil {
		t.Fatalf("read err=%v stat err=%v", err, statErr)
	}
	if !strings.Contains(string(body), "### Verse 14x") || info.Mode().Perm() != 0o644 {
		t.Fatalf("body=%s mode=%v", body, info.Mode().Perm())
	}
	stalePayload, _ := json.Marshal(markdownUpdateRequest{Markdown: strings.Replace(revised, "14x", "12x", 1), ExpectedHash: source.Hash})
	stale := httptest.NewRequest(http.MethodPut, "/api/songs/test-song/markdown", strings.NewReader(string(stalePayload)))
	stale.SetPathValue("id", "test-song")
	stale.Header.Set("X-ExeDev-UserID", "test-user")
	staleW := httptest.NewRecorder()
	server.HandleUpdateSongMarkdown(staleW, stale)
	if staleW.Code != http.StatusConflict {
		t.Fatalf("stale status=%d body=%s", staleW.Code, staleW.Body.String())
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

func TestShelleyEditJob(t *testing.T) {
	server := fixtureServer(t)
	modelOutput := `{"edits":[{"start":3,"end":3,"replacement":["### Verse 14x"]}]}`
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		encoded, _ := json.Marshal(map[string]string{"type": "response.output_text.delta", "delta": modelOutput})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	defer model.Close()
	server.LLMBaseURL = model.URL
	server.LeadSheetModel = "test-model"
	request := httptest.NewRequest(http.MethodPost, "/api/shelley/edit", strings.NewReader(`{"prompt":"The verse is actually 14 bars","song_id":"test-song","path":"/song/test-song"}`))
	request.Header.Set("X-ExeDev-UserID", "test-user")
	w := httptest.NewRecorder()
	server.HandleShelleyEdit(w, request)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var accepted shelleyEditJob
	if err := json.Unmarshal(w.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		server.mu.RLock()
		job := *server.shelleyJobs[accepted.ID]
		server.mu.RUnlock()
		if job.Status == "done" {
			body, err := os.ReadFile(filepath.Join(server.RepoRoot, "songs", "Test-Song.md"))
			if err != nil || !strings.Contains(string(body), "### Verse 14x") || !strings.Contains(string(body), "original_key: G") {
				t.Fatalf("body=%s err=%v", body, err)
			}
			return
		}
		if job.Status == "error" {
			t.Fatalf("job=%#v", job)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Shelley job did not finish")
}

func TestApplyFocusedEditPlanPreservesUntouchedBytes(t *testing.T) {
	tests := []struct {
		name, original, want string
		plan                 focusedEditPlan
	}{
		{"lf without final newline", "---\nartist: Example\n---\n\n# Demo\n\n### Verse 8x\nOne line", "---\nartist: Example\n---\n\n# Demo\n\n### Verse 14x\nOne line", focusedEditPlan{Edits: []focusedLineEdit{{Start: 3, End: 3, Replacement: []string{"### Verse 14x"}}}}},
		{"crlf with final newline", "---\r\nartist: Example\r\n---\r\n\r\n# Demo\r\n\r\n### Verse 8x\r\nOne line\r\n", "---\r\nartist: Example\r\n---\r\n\r\n# Demo\r\n\r\n### Verse 14x\r\nOne line\r\n", focusedEditPlan{Edits: []focusedLineEdit{{Start: 3, End: 3, Replacement: []string{"### Verse 14x"}}}}},
		{"multiple ascending ranges", "# Demo\n\n### Verse 8x\nOne line\nTwo line\n", "# Demo\n\n### Verse 14x\nOne line\nTwo lines\n", focusedEditPlan{Edits: []focusedLineEdit{{Start: 3, End: 3, Replacement: []string{"### Verse 14x"}}, {Start: 5, End: 5, Replacement: []string{"Two lines"}}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := applyFocusedEditPlan("Demo", tt.original, tt.plan)
			if err != nil || got != tt.want {
				t.Fatalf("got=%q want=%q err=%v", got, tt.want, err)
			}
		})
	}
	invalid := []focusedEditPlan{
		{Edits: []focusedLineEdit{{Start: 3, End: 3, Replacement: []string{"### Verse 14x\nInjected"}}}},
		{Edits: []focusedLineEdit{{Start: 4, End: 4, Replacement: []string{"One"}}, {Start: 3, End: 3, Replacement: []string{"### Verse 14x"}}}},
	}
	for _, plan := range invalid {
		if _, err := applyFocusedEditPlan("Demo", "# Demo\n\n### Verse 8x\nOne\n", plan); err == nil {
			t.Fatalf("invalid plan accepted: %#v", plan)
		}
	}
}

func TestLeadSheetModelCompactsRepeatedSections(t *testing.T) {
	modelOutput := `{"sections":[{"heading":"Verse 1","start":1,"end":2,"repeat_of":0},{"heading":"Chorus","start":3,"end":5,"repeat_of":0},{"heading":"Verse 2","start":6,"end":7,"repeat_of":0},{"heading":"Chorus","start":8,"end":10,"repeat_of":2}]}`
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		encoded, _ := json.Marshal(map[string]string{"type": "response.output_text.delta", "delta": modelOutput})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	defer model.Close()
	server := fixtureServer(t)
	server.LLMBaseURL = model.URL
	server.LeadSheetModel = "test-model"
	lyrics := "First line\nSecond line\n\nSing it once\nSing it twice\nSing it three times\n\nOther line\nLast line\n\nSing it once\nSing it twice\nSing it three times"
	draft, err := server.structureLyricsWithModel("Demo", lyrics)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(draft, "Sing it once") != 1 || strings.Count(draft, "### Chorus") != 2 || !strings.Contains(draft, "First line  \nSecond line") {
		t.Fatalf("unexpected model draft: %s", draft)
	}
	alteredPlan := `{"sections":[{"heading":"Chorus","start":1,"end":3,"repeat_of":0},{"heading":"Chorus","start":4,"end":6,"repeat_of":1}]}`
	altered, err := renderModelLeadSheet("Demo", []string{"one", "two", "three", "one", "two", "changed"}, alteredPlan)
	if err != nil || !strings.Contains(altered, "changed") || strings.Count(altered, "one") != 2 {
		t.Fatalf("altered repeat was abbreviated: %s err=%v", altered, err)
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
	request := httptest.NewRequest(http.MethodPost, "https://songs.example/api", nil)
	request.Header.Set("Origin", "https://evil.example")
	if sameOriginMutation(request) {
		t.Fatal("cross-origin mutation accepted")
	}
	request.Header.Set("Origin", "http://songs.example")
	if sameOriginMutation(request) {
		t.Fatal("cross-scheme mutation accepted")
	}
	request.Header.Set("Origin", "https://songs.example")
	if !sameOriginMutation(request) {
		t.Fatal("same-origin mutation rejected")
	}
	if got := preserveMarkdownLineEndings("one\r\ntwo\r\n", "one\ntwo\n"); got != "one\r\ntwo\r\n" {
		t.Fatalf("CRLF not preserved: %q", got)
	}
	body := preserveLeadSheetLineBreaks("# Demo\n\nFirst line\nSecond line\n\n### Chorus\nThird line\nFourth line")
	if !strings.Contains(body, "First line  \nSecond line") || !strings.Contains(body, "Third line  \nFourth line") {
		t.Fatalf("line breaks not preserved: %q", body)
	}
}
