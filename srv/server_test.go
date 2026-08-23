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
	set := "---\ntitle: Test Set\ndate: 2026-08-06\nlocation: Test Room\n---\n\n# Test Set\n\n## Set 1 — Slow\n1. [Test Song](../songs/Test-Song.md) — singer: Alex — note: Count in\n"
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
	if item := server.sets[0].Items[0]; item.Singer != "Alex" || item.Note != "Count in" || item.EffectiveKey() != "A" || item.EffectiveBPM() != "" {
		t.Fatalf("set item metadata=%#v", item)
	}

	tests := []struct {
		name, path string
		handler    http.HandlerFunc
		contains   string
	}{
		{"home", "/", server.HandleHome, "Test Song"},
		{"song", "/song/test-song", server.HandleSong, "Two lines"},
		{"set", "/sets/test-set", server.HandleSet, "Alex"},
		{"live", "/sets/test-set/live", server.HandleLiveSet, "Alex"},
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
			if tt.name == "set" && !strings.Contains(w.Body.String(), `<h2 class="set-column-heading">Set 1 — Slow</h2><button class="set-drag-handle"`) {
				t.Fatalf("set heading is not rendered as a standalone row before the first song: %s", w.Body.String())
			}
			if tt.name == "set" && !strings.Contains(w.Body.String(), `data-set-print onclick="window.print()"`) {
				t.Fatalf("set page is missing the print-only Set List action: %s", w.Body.String())
			}
		})
	}
}

func TestSetPerformanceDetailsRenderAndKeepNotes(t *testing.T) {
	server := fixtureServer(t)
	setPath := filepath.Join(server.RepoRoot, "sets", "test-set.md")
	body, err := os.ReadFile(setPath)
	if err != nil {
		t.Fatal(err)
	}
	body = []byte(strings.Replace(string(body), "— singer: Alex — note: Count in", "— singer: Alex — key: D — bpm: 132.6 BPM — note: Count in", 1))
	if err := os.WriteFile(setPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := server.Reindex(); err != nil {
		t.Fatal(err)
	}
	item := server.sets[0].Items[0]
	if item.PerformanceKey != "D" || item.PerformanceBPM != "132.6" || item.Note != "Count in" {
		t.Fatalf("parsed set performance details=%#v", item)
	}

	setRequest := httptest.NewRequest(http.MethodGet, "/sets/test-set", nil)
	setRequest.SetPathValue("id", "test-set")
	setResponse := httptest.NewRecorder()
	server.HandleSet(setResponse, setRequest)
	if setResponse.Code != http.StatusOK {
		t.Fatalf("set status=%d body=%s", setResponse.Code, setResponse.Body.String())
	}
	setBody := setResponse.Body.String()
	if !strings.Contains(setBody, "(Alex · D · 133 BPM)") || !strings.Contains(setBody, "<small>Count in</small>") {
		t.Fatalf("set performance details or note missing: %s", setBody)
	}

	liveRequest := httptest.NewRequest(http.MethodGet, "/sets/test-set/live", nil)
	liveRequest.SetPathValue("id", "test-set")
	liveResponse := httptest.NewRecorder()
	server.HandleLiveSet(liveResponse, liveRequest)
	if liveResponse.Code != http.StatusOK {
		t.Fatalf("live status=%d body=%s", liveResponse.Code, liveResponse.Body.String())
	}
	liveBody := liveResponse.Body.String()
	for _, want := range []string{"<dt>Key</dt><dd>D</dd>", "<dt>BPM</dt><dd>133</dd>", "<strong>Count in</strong>"} {
		if !strings.Contains(liveBody, want) {
			t.Fatalf("live performance detail missing %q: %s", want, liveBody)
		}
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

func TestParseSetItemDetails(t *testing.T) {
	tests := []struct {
		raw, singer, key, bpm, note string
	}{
		{"— singer: Kyle — key: D — bpm: 132 — note: short count-in", "Kyle", "D", "132", "short count-in"},
		{"singer: Kiana", "Kiana", "", "", ""},
		{"— bpm: 128 BPM", "", "", "128", ""},
		{"Watch the ending", "", "", "", "Watch the ending"},
		{"— note: First — extra detail", "", "", "", "First — extra detail"},
	}
	for _, tt := range tests {
		singer, key, bpm, note := parseSetItemDetails(tt.raw)
		if singer != tt.singer || key != tt.key || bpm != tt.bpm || note != tt.note {
			t.Errorf("parseSetItemDetails(%q)=(%q,%q,%q,%q), want (%q,%q,%q,%q)", tt.raw, singer, key, bpm, note, tt.singer, tt.key, tt.bpm, tt.note)
		}
	}
}

func TestSetItemPerformanceDetailsOverrideSongMetadata(t *testing.T) {
	item := SetItem{Singer: "Kyle", Song: &Song{Key: "A", BPM: "124.6 BPM"}}
	if item.EffectiveKey() != "A" || item.EffectiveBPM() != "" || item.DisplayBPM() != "" {
		t.Fatalf("unreviewed lead-sheet BPM should not become performance BPM: key=%q bpm=%q display=%q", item.EffectiveKey(), item.EffectiveBPM(), item.DisplayBPM())
	}
	item.PerformanceKey = "D"
	item.PerformanceBPM = "132.4"
	if item.EffectiveKey() != "D" || item.EffectiveBPM() != "132.4" || item.DisplayBPM() != "132" {
		t.Fatalf("set-list override failed: key=%q bpm=%q display=%q", item.EffectiveKey(), item.EffectiveBPM(), item.DisplayBPM())
	}
	item.PerformanceBPM = "120-124"
	if item.DisplayBPM() != "120-124" {
		t.Fatalf("non-numeric BPM should be preserved, got %q", item.DisplayBPM())
	}
}

func TestReorderSetMarkdownPreservesItemDetailsAndBreaks(t *testing.T) {
	set := &SetList{Items: []SetItem{
		{Position: 1, Label: "One", Target: "../songs/one.md", Suffix: "— singer: Kyle", ColumnHeading: "Set 1 — Slow"},
		{Position: 2, Label: "Two", Target: "../songs/two.md", Suffix: "— singer: Kiana — key: Bb — bpm: 110 — note: Count in"},
		{Position: 3, Label: "Three", Target: "../songs/three.md", ColumnBreakBefore: true, ColumnHeading: "Set 2 — Fast"},
	}}
	current := "---\ntitle: Test\n---\n\n# Test\n\n## Set 1 — Slow\n1. [One](../songs/one.md) — singer: Kyle\n2. [Two](../songs/two.md) — singer: Kiana — key: Bb — bpm: 110 — note: Count in\n<!-- column-break -->\n## Set 2 — Fast\n3. [Three](../songs/three.md)\n"
	updated, err := reorderSetMarkdown(current, set, []int{2, 1, 3}, []int{2})
	if err != nil {
		t.Fatal(err)
	}
	want := "## Set 1 — Slow\n1. [Two](../songs/two.md) — singer: Kiana — key: Bb — bpm: 110 — note: Count in\n2. [One](../songs/one.md) — singer: Kyle\n<!-- column-break -->\n## Set 2 — Fast\n3. [Three](../songs/three.md)"
	if !strings.Contains(updated, want) {
		t.Fatalf("updated markdown missing reordered list:\n%s", updated)
	}
	deleted, err := deleteSetItemMarkdown(current, set, 1)
	if err != nil || !strings.Contains(deleted, "## Set 1 — Slow\n1. [Two](../songs/two.md)") || !strings.Contains(deleted, "<!-- column-break -->\n## Set 2 — Fast") {
		t.Fatalf("heading did not survive deletion of its first song: err=%v\n%s", err, deleted)
	}
	unsafe := strings.Replace(current, "<!-- column-break -->", "Band announcement", 1)
	if _, err := reorderSetMarkdown(unsafe, set, []int{1, 2, 3}, nil); err == nil {
		t.Fatal("expected inter-entry Markdown to block reordering")
	}
}

func TestUnresolvedSetItemsRemainUsable(t *testing.T) {
	server := fixtureServer(t)
	setPath := filepath.Join(server.RepoRoot, "sets", "test-set.md")
	body := "---\ntitle: Imported Draft\ndate: 2015-09\ndate_precision: month\nband: Example Band\nstatus: draft\nreview_required: true\n---\n\n# Imported Draft\n\n1. [Test Song](../songs/Test-Song.md) — singer: Alex\n2. [Missing Song](unresolved:missing-song) — singer: Casey — note: Import review\n"
	if err := os.WriteFile(setPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := server.Reindex(); err != nil {
		t.Fatal(err)
	}
	set := server.setsByID["test-set"]
	if set == nil || len(set.Items) != 2 || set.UnresolvedCount != 1 || set.Status != "draft" || set.DatePrecision != "month" || set.Band != "Example Band" {
		t.Fatalf("unexpected imported set: %#v", set)
	}
	missing := set.Items[1]
	if !missing.Unresolved || missing.Song != nil || missing.Target != "unresolved:missing-song" || missing.Singer != "Casey" || missing.Note != "Import review" {
		t.Fatalf("unexpected unresolved item: %#v", missing)
	}

	for _, tt := range []struct {
		path, id, contains string
		handler            http.HandlerFunc
	}{
		{path: "/sets/test-set", id: "test-set", contains: "Lead sheet needed", handler: server.HandleSet},
		{path: "/sets/test-set/live", id: "test-set", contains: "Lead sheet unavailable", handler: server.HandleLiveSet},
	} {
		req := httptest.NewRequest(http.MethodGet, tt.path, nil)
		req.SetPathValue("id", tt.id)
		w := httptest.NewRecorder()
		tt.handler(w, req)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), tt.contains) {
			t.Fatalf("%s status=%d missing %q: %s", tt.path, w.Code, tt.contains, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "/song/missing-song") {
			t.Fatalf("%s rendered a fake song link", tt.path)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/offline/sets/test-set", nil)
	req.SetPathValue("id", "test-set")
	w := httptest.NewRecorder()
	server.HandleOfflineManifest(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("offline status=%d body=%s", w.Code, w.Body.String())
	}
	var manifest struct {
		URLs []string `json:"urls"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(manifest.URLs, "\n")
	if !strings.Contains(joined, "/song/test-song") || strings.Contains(joined, "missing-song") {
		t.Fatalf("unexpected offline URLs: %#v", manifest.URLs)
	}

	updated, err := reorderSetMarkdown(body, set, []int{2, 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(updated, "1. [Missing Song](unresolved:missing-song) — singer: Casey — note: Import review") {
		t.Fatalf("unresolved target was not preserved:\n%s", updated)
	}

	broken := "---\ntitle: Broken\n---\n\n# Broken\n\n1. [Missing](../songs/Missing.md)\n"
	if err := os.WriteFile(filepath.Join(server.RepoRoot, "sets", "broken.md"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := server.loadSets(server.songsByPath); err == nil || !strings.Contains(err.Error(), "references missing song") {
		t.Fatalf("expected conventional missing link to fail, got %v", err)
	}
}

func TestSetParserRejectsMoreThanThreeColumns(t *testing.T) {
	server := fixtureServer(t)
	body := "---\ntitle: Too Many Columns\n---\n\n# Too Many Columns\n\n1. [One](../songs/Test-Song.md)\n<!-- column-break -->\n2. [Two](../songs/Test-Song.md)\n<!-- column-break -->\n3. [Three](../songs/Test-Song.md)\n<!-- column-break -->\n4. [Four](../songs/Test-Song.md)\n"
	if err := os.WriteFile(filepath.Join(server.RepoRoot, "sets", "test-set.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := server.loadSets(server.songsByPath); err == nil || !strings.Contains(err.Error(), "more than two column breaks") {
		t.Fatalf("expected column-break validation error, got %v", err)
	}
}

func TestSongNavigationUsesCatalogOrder(t *testing.T) {
	server := fixtureServer(t)
	current := server.songs[0]
	previous := &Song{ID: "alpha", Title: "Alpha"}
	next := &Song{ID: "zulu", Title: "Zulu"}
	server.songs = []*Song{previous, current, next}

	req := httptest.NewRequest(http.MethodGet, "/song/test-song", nil)
	req.SetPathValue("id", "test-song")
	w := httptest.NewRecorder()
	server.HandleSong(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	for _, want := range []string{`data-previous-song="/song/alpha"`, `data-next-song="/song/zulu"`} {
		if !strings.Contains(w.Body.String(), want) {
			t.Errorf("body missing %q", want)
		}
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

func TestDirectSetMarkdownEditWorkflow(t *testing.T) {
	server := fixtureServer(t)
	get := httptest.NewRequest(http.MethodGet, "/api/sets/test-set/markdown", nil)
	get.SetPathValue("id", "test-set")
	get.Header.Set("X-ExeDev-UserID", "test-user")
	getW := httptest.NewRecorder()
	server.HandleSetMarkdown(getW, get)
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
	revised := strings.Replace(source.Markdown, "location: Test Room", "location: New Room", 1)
	payload, _ := json.Marshal(markdownUpdateRequest{Markdown: revised, ExpectedHash: source.Hash})
	put := httptest.NewRequest(http.MethodPut, "/api/sets/test-set/markdown", strings.NewReader(string(payload)))
	put.SetPathValue("id", "test-set")
	put.Header.Set("X-ExeDev-UserID", "test-user")
	put.Header.Set("Content-Type", "application/json")
	putW := httptest.NewRecorder()
	server.HandleUpdateSetMarkdown(putW, put)
	if putW.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", putW.Code, putW.Body.String())
	}
	if got := server.setsByID["test-set"].Location; got != "New Room" {
		t.Fatalf("indexed location=%q", got)
	}
}

func TestStructuredSetEditRejectsDiskNewerThanCatalog(t *testing.T) {
	server := fixtureServer(t)
	setPath := filepath.Join(server.RepoRoot, "sets", "test-set.md")
	current, err := os.ReadFile(setPath)
	if err != nil {
		t.Fatal(err)
	}
	external := strings.Replace(string(current), "1. [Test Song]", "1. [Test Song]", 1) + "2. [Test Song](../songs/Test-Song.md) — note: External addition\n"
	if err := os.WriteFile(setPath, []byte(external), 0o644); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(setItemAddRequest{ExpectedHash: hashBytes([]byte(external)), SongID: "test-song", Column: 1})
	request := httptest.NewRequest(http.MethodPost, "/api/sets/test-set/items", strings.NewReader(string(payload)))
	request.SetPathValue("id", "test-set")
	request.Header.Set("X-ExeDev-UserID", "test-user")
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.HandleAddSetItem(w, request)
	if w.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	after, err := os.ReadFile(setPath)
	if err != nil || string(after) != external {
		t.Fatalf("external Markdown was overwritten: err=%v\n%s", err, after)
	}
}

func TestSetOrderWorkflow(t *testing.T) {
	server := fixtureServer(t)
	second := "---\nartist: Example\n---\n\n# Second Song\n\n### Verse\nLine\n"
	if err := os.WriteFile(filepath.Join(server.RepoRoot, "songs", "Second-Song.md"), []byte(second), 0o644); err != nil {
		t.Fatal(err)
	}
	setPath := filepath.Join(server.RepoRoot, "sets", "test-set.md")
	setBody := "---\ntitle: Test Set\ndate: 2026-08-06\nlocation: Test Room\n---\n\n# Test Set\n\n## Set 1 — Slow\n1. [Test Song](../songs/Test-Song.md) — singer: Alex — note: Count in\n<!-- column-break -->\n## Set 2 — Fast\n2. [Second Song](../songs/Second-Song.md) — singer: Kiana\n"
	if err := os.WriteFile(setPath, []byte(setBody), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "songs/Second-Song.md", "sets/test-set.md"}, {"commit", "-m", "expand fixture set"}, {"push", "origin", "main"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = server.RepoRoot
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := server.Reindex(); err != nil {
		t.Fatal(err)
	}
	set := server.setsByID["test-set"]
	if len(set.Items) != 2 || !set.Items[1].ColumnBreakBefore || set.Items[0].ColumnHeading != "Set 1 — Slow" || set.Items[1].ColumnHeading != "Set 2 — Fast" {
		t.Fatalf("column headings or break were not indexed: %#v", set.Items)
	}
	payload, _ := json.Marshal(setOrderRequest{ExpectedHash: set.Hash, Order: []int{2, 1}, Breaks: []int{1}})
	req := httptest.NewRequest(http.MethodPut, "/api/sets/test-set/order", strings.NewReader(string(payload)))
	req.SetPathValue("id", "test-set")
	req.Header.Set("X-ExeDev-UserID", "test-user")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.HandleUpdateSetOrder(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	updated, err := os.ReadFile(setPath)
	if err != nil {
		t.Fatal(err)
	}
	want := "## Set 1 — Slow\n1. [Second Song](../songs/Second-Song.md) — singer: Kiana\n<!-- column-break -->\n## Set 2 — Fast\n2. [Test Song](../songs/Test-Song.md) — singer: Alex — note: Count in"
	if !strings.Contains(string(updated), want) {
		t.Fatalf("unexpected set markdown:\n%s", updated)
	}

	set = server.setsByID["test-set"]
	addPayload, _ := json.Marshal(setItemAddRequest{ExpectedHash: set.Hash, SongID: "test-song", Singer: "Guest", PerformanceKey: "Bb", PerformanceBPM: "110 BPM", Note: "Added in UI", Column: 1})
	addRequest := httptest.NewRequest(http.MethodPost, "/api/sets/test-set/items", strings.NewReader(string(addPayload)))
	addRequest.SetPathValue("id", "test-set")
	addRequest.Header.Set("X-ExeDev-UserID", "test-user")
	addRequest.Header.Set("Content-Type", "application/json")
	addW := httptest.NewRecorder()
	server.HandleAddSetItem(addW, addRequest)
	if addW.Code != http.StatusOK {
		t.Fatalf("add status=%d body=%s", addW.Code, addW.Body.String())
	}
	added, err := os.ReadFile(setPath)
	if err != nil {
		t.Fatal(err)
	}
	addedLine := "2. [Test Song](../songs/Test-Song.md) — singer: Guest — key: Bb — bpm: 110 — note: Added in UI\n<!-- column-break -->"
	if !strings.Contains(string(added), addedLine) {
		t.Fatalf("added song missing from set markdown:\n%s", added)
	}

	set = server.setsByID["test-set"]
	deletePayload, _ := json.Marshal(setItemDeleteRequest{ExpectedHash: set.Hash})
	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/sets/test-set/items/2", strings.NewReader(string(deletePayload)))
	deleteRequest.SetPathValue("id", "test-set")
	deleteRequest.SetPathValue("position", "2")
	deleteRequest.Header.Set("X-ExeDev-UserID", "test-user")
	deleteRequest.Header.Set("Content-Type", "application/json")
	deleteW := httptest.NewRecorder()
	server.HandleDeleteSetItem(deleteW, deleteRequest)
	if deleteW.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", deleteW.Code, deleteW.Body.String())
	}
	deleted, err := os.ReadFile(setPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(deleted), "Added in UI") || !strings.Contains(string(deleted), want) {
		t.Fatalf("unexpected set markdown after delete:\n%s", deleted)
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
			got, err := applyFocusedEditPlan("Demo", tt.original, tt.plan, "")
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
		if _, err := applyFocusedEditPlan("Demo", "# Demo\n\n### Verse 8x\nOne\n", plan, ""); err == nil {
			t.Fatalf("invalid plan accepted: %#v", plan)
		}
	}

	titlePlan := focusedEditPlan{Edits: []focusedLineEdit{{Start: 1, End: 1, Replacement: []string{"# Fire Woman/She Sells Sanctuary"}}}}
	original := "# Fire Woman\n\n### Intro\nRiff\n"
	if _, err := applyFocusedEditPlan("Fire Woman", original, titlePlan, ""); err == nil {
		t.Fatal("title change without explicit permission was accepted")
	}
	if got, err := applyFocusedEditPlan("Fire Woman", original, titlePlan, "Fire Woman/She Sells Sanctuary"); err != nil || !strings.HasPrefix(got, "# Fire Woman/She Sells Sanctuary\n") {
		t.Fatalf("explicit title change got=%q err=%v", got, err)
	}
	if _, err := applyFocusedEditPlan("Fire Woman", original, titlePlan, "A Different Requested Title"); err == nil {
		t.Fatal("model title differing from the requested title was accepted")
	}
}

func TestFocusedEditTitleIntent(t *testing.T) {
	allowed := map[string]string{
		`We want to "mash up" Fire Woman with another song by the Cult called "She Sells Sanctuary". Can you change the title to "Fire Woman/She Sells Sanctuary"?`: "Fire Woman/She Sells Sanctuary",
		`Can you change the title to "Fire Woman/She Sells Sanctuary"?`:                                                                                             "Fire Woman/She Sells Sanctuary",
		"Rename this song to the mashup name":     "the mashup name",
		"Set the song title to Fire Woman mashup": "Fire Woman mashup",
	}
	for request, want := range allowed {
		if got := focusedEditRequestedTitle(request); got != want {
			t.Errorf("focusedEditRequestedTitle(%q)=%q, want %q", request, got, want)
		}
	}
	for _, request := range []string{
		"Change Verse 2 to 14 bars",
		"Change Verse 2, but do not change the song title",
		"Do not retitle this song",
		"Change Verse 2, but do not rename the song",
		`Change Verse 2 to include the word "rename"`,
		"Rename Verse 2 to Chorus",
		`Please retitle the chorus as "Final Chorus"`,
		`Please update the lyric to say "rename"`,
		"Change the section title to Final Chorus",
		"Change the name of the singer to Kyle",
		`Please update lyrics to say "change the title"`,
		"Do not change the title to Foo",
		"Do not retitle this song to Foo",
		`Don't change the song title to "Foo"`,
		`Please update the lyric to say "change the title to Foo"`,
	} {
		if got := focusedEditRequestedTitle(request); got != "" {
			t.Errorf("ordinary focused edit extracted title %q for %q", got, request)
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
