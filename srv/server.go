package srv

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"songs.exe.dev/db"
)

type Song struct {
	ID             string        `json:"id"`
	Path           string        `json:"path"`
	Title          string        `json:"title"`
	Artist         string        `json:"artist,omitempty"`
	Key            string        `json:"key,omitempty"`
	BPM            string        `json:"bpm,omitempty"`
	OriginalKey    string        `json:"original_key,omitempty"`
	OriginalBPM    string        `json:"original_bpm,omitempty"`
	SourceURL      string        `json:"source_url,omitempty"`
	SourceProvider string        `json:"source_provider,omitempty"`
	HTML           template.HTML `json:"-"`
	Hash           string        `json:"hash"`
	Modified       time.Time     `json:"modified"`
}

type SetItem struct {
	Position int
	Label    string
	Note     string
	Song     *Song
}

type SetList struct {
	ID       string
	Path     string
	Title    string
	Date     string
	Location string
	Hash     string
	Items    []SetItem
}

type Server struct {
	DB            *sql.DB
	Hostname      string
	RepoRoot      string
	TemplatesDir  string
	StaticDir     string
	ApexPath      string
	HTTPClient    *http.Client
	LRCLIBBaseURL string
	LyricsOvhURL  string
	DeezerBaseURL string

	mu          sync.RWMutex
	writeMu     sync.Mutex
	songs       []*Song
	songsByID   map[string]*Song
	songsByPath map[string]*Song
	sets        []*SetList
	setsByID    map[string]*SetList
	lyricsSem   chan struct{}
}

type pageData struct {
	Title               string
	UserEmail           string
	Songs               []*Song
	Sets                []*SetList
	Song                *Song
	Set                 *SetList
	BuildTime           string
	SongCount           int
	SetCount            int
	ShelleyURL          string
	DraftTitle          string
	DraftArtist         string
	DraftKey            string
	DraftBPM            string
	DraftOriginalKey    string
	DraftOriginalBPM    string
	DraftSource         string
	DraftSourceProvider string
	DraftBody           string
	FormError           string
}

type lyricsChoice struct {
	Provider string  `json:"provider"`
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	Album    string  `json:"album,omitempty"`
	Duration float64 `json:"duration,omitempty"`
}

type lyricsImportRequest struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
}

type lyricsDraft struct {
	Title          string `json:"title"`
	Artist         string `json:"artist"`
	OriginalBPM    string `json:"original_bpm,omitempty"`
	SourceURL      string `json:"source_url"`
	SourceProvider string `json:"source_provider"`
	Body           string `json:"body"`
}

var (
	h1Pattern      = regexp.MustCompile(`(?m)^#\s+(.+?)\s*$`)
	setItemPattern = regexp.MustCompile(`^\s*\d+\.\s+\[([^]]+)\]\(([^)]+)\)\s*(.*)$`)
)

func New(dbPath, hostname, repoRoot string) (*Server, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(thisFile)
	apexPath, err := exec.LookPath("apex")
	if err != nil {
		return nil, fmt.Errorf("Apex Markdown Processor is required: %w", err)
	}
	wdb, err := db.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := db.RunMigrations(wdb); err != nil {
		_ = wdb.Close()
		return nil, err
	}
	s := &Server{
		DB: wdb, Hostname: hostname, RepoRoot: repoRoot,
		TemplatesDir: filepath.Join(baseDir, "templates"), StaticDir: filepath.Join(baseDir, "static"), ApexPath: apexPath,
		HTTPClient:    &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		LRCLIBBaseURL: "https://lrclib.net", LyricsOvhURL: "https://api.lyrics.ovh", DeezerBaseURL: "https://api.deezer.com", lyricsSem: make(chan struct{}, 4),
	}
	if err := s.Reindex(); err != nil {
		_ = wdb.Close()
		return nil, err
	}
	return s, nil
}

func (s *Server) Reindex() error {
	songs, byID, byPath, err := s.loadSongs()
	if err != nil {
		return err
	}
	sets, setsByID, err := s.loadSets(byPath)
	if err != nil {
		return err
	}
	if err := s.persistIndex(songs, sets); err != nil {
		return err
	}
	s.mu.Lock()
	s.songs, s.songsByID, s.songsByPath = songs, byID, byPath
	s.sets, s.setsByID = sets, setsByID
	s.mu.Unlock()
	slog.Info("catalog indexed", "songs", len(songs), "sets", len(sets))
	return nil
}

func (s *Server) loadSongs() ([]*Song, map[string]*Song, map[string]*Song, error) {
	root := filepath.Join(s.RepoRoot, "songs")
	var songs []*Song
	byID := map[string]*Song{}
	byPath := map[string]*Song{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(path), ".md") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(s.RepoRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		text := string(body)
		title := titleFromMarkdown(text)
		if title == "" {
			title = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		}
		artist := metadataValue(text, "artist")
		key := metadataValue(text, "performance_key")
		if key == "" {
			key = metadataValue(text, "key")
		}
		bpm := metadataValue(text, "bpm")
		originalKey := metadataValue(text, "original_key")
		originalBPM := metadataValue(text, "original_bpm")
		sourceURL := metadataValue(text, "source_url")
		sourceProvider := metadataValue(text, "source_provider")
		id := slugify(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
		if _, exists := byID[id]; exists {
			return fmt.Errorf("duplicate song id %q", id)
		}
		hash := hashBytes(body)
		rendered, err := s.renderMarkdown(path, hash)
		if err != nil {
			return fmt.Errorf("render %s: %w", rel, err)
		}
		info, _ := entry.Info()
		song := &Song{ID: id, Path: rel, Title: title, Artist: artist, Key: key, BPM: bpm, OriginalKey: originalKey, OriginalBPM: originalBPM, SourceURL: sourceURL, SourceProvider: sourceProvider, HTML: template.HTML(rendered), Hash: hash}
		if info != nil {
			song.Modified = info.ModTime()
		}
		songs = append(songs, song)
		byID[id] = song
		byPath[rel] = song
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	if err != nil {
		return nil, nil, nil, err
	}
	sort.Slice(songs, func(i, j int) bool { return strings.ToLower(songs[i].Title) < strings.ToLower(songs[j].Title) })
	return songs, byID, byPath, nil
}

func (s *Server) renderMarkdown(path, hash string) (string, error) {
	var cached string
	err := s.DB.QueryRow(`SELECT rendered_html FROM song_index WHERE path=? AND source_hash=?`, filepath.ToSlash(mustRel(s.RepoRoot, path)), hash).Scan(&cached)
	if err == nil {
		return cached, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	cmd := exec.Command(s.ApexPath, "--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html", path)
	cmd.Dir = s.RepoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("apex: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (s *Server) loadSets(songsByPath map[string]*Song) ([]*SetList, map[string]*SetList, error) {
	root := filepath.Join(s.RepoRoot, "sets")
	var sets []*SetList
	byID := map[string]*SetList{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(path), ".md") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(s.RepoRoot, path)
		rel = filepath.ToSlash(rel)
		id := slugify(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
		title := metadataValue(string(body), "title")
		if title == "" {
			title = titleFromMarkdown(string(body))
		}
		if title == "" {
			title = id
		}
		set := &SetList{ID: id, Path: rel, Title: title, Date: metadataValue(string(body), "date"), Location: metadataValue(string(body), "location"), Hash: hashBytes(body)}
		lines := strings.Split(string(body), "\n")
		for _, line := range lines {
			m := setItemPattern.FindStringSubmatch(line)
			if len(m) == 0 {
				continue
			}
			target := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(rel), filepath.FromSlash(m[2]))))
			target = strings.TrimPrefix(target, "./")
			song := songsByPath[target]
			if song == nil {
				return fmt.Errorf("set %s references missing song %s", rel, target)
			}
			note := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(m[3]), "—"))
			set.Items = append(set.Items, SetItem{Position: len(set.Items) + 1, Label: m[1], Note: note, Song: song})
		}
		sets = append(sets, set)
		byID[id] = set
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].Date > sets[j].Date })
	return sets, byID, nil
}

func (s *Server) persistIndex(songs []*Song, sets []*SetList) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM song_index`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM set_index`); err != nil {
		return err
	}
	for _, song := range songs {
		if _, err = tx.Exec(`INSERT INTO song_index(id,path,title,normalized_title,source_hash,rendered_html,indexed_at) VALUES(?,?,?,?,?,?,?)`, song.ID, song.Path, song.Title, normalize(song.Title), song.Hash, string(song.HTML), time.Now()); err != nil {
			return err
		}
	}
	for _, set := range sets {
		if _, err = tx.Exec(`INSERT INTO set_index(id,path,title,event_date,location,source_hash,indexed_at) VALUES(?,?,?,?,?,?,?)`, set.ID, set.Path, set.Title, set.Date, set.Location, set.Hash, time.Now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) HandleHome(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	songs := append([]*Song(nil), s.songs...)
	s.mu.RUnlock()
	s.render(w, r, "home.html", pageData{Title: "Songs", UserEmail: r.Header.Get("X-ExeDev-Email"), Songs: songs, BuildTime: time.Now().Format(time.RFC3339)})
}

func (s *Server) HandleSetLists(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	sets := append([]*SetList(nil), s.sets...)
	s.mu.RUnlock()
	s.render(w, r, "sets.html", pageData{Title: "Set Lists", UserEmail: r.Header.Get("X-ExeDev-Email"), Sets: sets})
}

func (s *Server) HandleNewSong(w http.ResponseWriter, r *http.Request) {
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	body := ""
	if title != "" {
		body = "# " + title + "\n\n### Intro\n\n### Verse 1\n\n### Chorus\n"
	}
	s.render(w, r, "new_song.html", pageData{Title: "Add a Song", UserEmail: r.Header.Get("X-ExeDev-Email"), DraftTitle: title, DraftBody: body})
}

func (s *Server) HandleCreateSong(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(r.Header.Get("X-ExeDev-UserID")) == "" {
		http.Error(w, "Sign in through exe.dev to add a song", http.StatusUnauthorized)
		return
	}
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(u.Host, r.Host) {
			http.Error(w, "Cross-origin song creation is not allowed", http.StatusForbidden)
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Invalid song form", http.StatusBadRequest)
		return
	}
	draft := pageData{
		Title: "Add a Song", UserEmail: r.Header.Get("X-ExeDev-Email"),
		DraftTitle: strings.TrimSpace(r.FormValue("title")), DraftArtist: strings.TrimSpace(r.FormValue("artist")),
		DraftKey: strings.TrimSpace(r.FormValue("key")), DraftBPM: strings.TrimSpace(r.FormValue("bpm")),
		DraftOriginalKey: strings.TrimSpace(r.FormValue("original_key")), DraftOriginalBPM: strings.TrimSpace(r.FormValue("original_bpm")),
		DraftSource: strings.TrimSpace(r.FormValue("source_url")), DraftSourceProvider: strings.TrimSpace(r.FormValue("source_provider")),
		DraftBody: strings.TrimSpace(r.FormValue("body")),
	}
	if draft.DraftTitle == "" {
		draft.FormError = "Song title is required."
		s.renderStatus(w, r, "new_song.html", draft, http.StatusBadRequest)
		return
	}
	if r.FormValue("rights_confirmed") != "yes" {
		draft.FormError = "Confirm that you are authorized to store and use this material."
		s.renderStatus(w, r, "new_song.html", draft, http.StatusBadRequest)
		return
	}
	for label, value := range map[string]string{"BPM": draft.DraftBPM, "Original BPM": draft.DraftOriginalBPM} {
		if value == "" {
			continue
		}
		bpm, err := strconv.ParseFloat(value, 64)
		if err != nil || bpm < 20 || bpm > 300 {
			draft.FormError = label + " must be a number between 20 and 300."
			s.renderStatus(w, r, "new_song.html", draft, http.StatusBadRequest)
			return
		}
	}
	if draft.DraftSource != "" {
		u, err := url.Parse(draft.DraftSource)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			draft.FormError = "Source URL must be a complete HTTPS URL."
			s.renderStatus(w, r, "new_song.html", draft, http.StatusBadRequest)
			return
		}
	}
	id := slugify(draft.DraftTitle)
	if id == "" {
		draft.FormError = "The title cannot produce a usable filename."
		s.renderStatus(w, r, "new_song.html", draft, http.StatusBadRequest)
		return
	}
	body := draft.DraftBody
	if body == "" {
		body = "# " + draft.DraftTitle + "\n\n### Intro\n\n### Verse 1\n\n### Chorus"
	}
	if titleFromMarkdown(body) == "" {
		body = "# " + draft.DraftTitle + "\n\n" + body
	}
	body = preserveLeadSheetLineBreaks(body)
	markdown := buildSongMarkdown(id, draft.DraftTitle, draft.DraftArtist, draft.DraftKey, draft.DraftBPM, draft.DraftOriginalKey, draft.DraftOriginalBPM, draft.DraftSourceProvider, draft.DraftSource, body)
	if err := s.createSongFile(id, markdown); err != nil {
		if errors.Is(err, os.ErrExist) {
			draft.FormError = "A song with this filename already exists. Search for it or choose a more specific title."
			s.renderStatus(w, r, "new_song.html", draft, http.StatusConflict)
			return
		}
		draft.FormError = err.Error()
		s.renderStatus(w, r, "new_song.html", draft, http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/song/"+id, http.StatusSeeOther)
}

func (s *Server) createSongFile(id, markdown string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	path := filepath.Join(s.RepoRoot, "songs", id+".md")
	if _, err := os.Stat(path); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".song-*.md")
	if err != nil {
		return fmt.Errorf("create draft: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.WriteString(markdown); err != nil {
		temp.Close()
		return fmt.Errorf("write draft: %w", err)
	}
	if err := temp.Close(); err != nil {
		return err
	}
	cmd := exec.Command(s.ApexPath, "--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html", tempPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("Apex could not render the draft: %s", strings.TrimSpace(string(out)))
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("publish song: %w", err)
	}
	rel := filepath.ToSlash(mustRel(s.RepoRoot, path))
	if out, err := gitCommand(s.RepoRoot, "add", "--", rel); err != nil {
		return fmt.Errorf("git add: %s", out)
	}
	if out, err := gitCommand(s.RepoRoot, "commit", "-m", "Add lead sheet: "+titleFromMarkdown(markdown), "--", rel); err != nil {
		return fmt.Errorf("git commit: %s", out)
	}
	if out, err := gitCommand(s.RepoRoot, "push", "origin", "main"); err != nil {
		slog.Error("push new song", "path", rel, "error", err, "output", out)
	}
	return s.Reindex()
}

func (s *Server) HandleLyricsSearch(w http.ResponseWriter, r *http.Request) {
	if !authenticatedRequest(w, r) {
		return
	}
	if !s.acquireLyricsRequest(w) {
		return
	}
	defer s.releaseLyricsRequest()
	titleQuery := strings.TrimSpace(r.URL.Query().Get("title"))
	artistQuery := strings.TrimSpace(r.URL.Query().Get("artist"))
	query := strings.TrimSpace(strings.Join([]string{artistQuery, titleQuery}, " "))
	if query == "" {
		query = strings.TrimSpace(r.URL.Query().Get("q"))
	}
	if len(query) < 2 || len(query) > 160 {
		http.Error(w, "Enter at least two characters", http.StatusBadRequest)
		return
	}
	type searchResult struct {
		choices []lyricsChoice
		err     error
	}
	results := make(chan searchResult, 2)
	go func() { choices, err := s.searchLRCLIB(query); results <- searchResult{choices, err} }()
	go func() { choices, err := s.searchLyricsOvh(query); results <- searchResult{choices, err} }()
	choices := make([]lyricsChoice, 0, 12)
	var failures []string
	for range 2 {
		result := <-results
		if result.err != nil {
			failures = append(failures, result.err.Error())
			continue
		}
		choices = append(choices, result.choices...)
	}
	if len(choices) == 0 && len(failures) > 0 {
		http.Error(w, "Lyrics providers are temporarily unavailable", http.StatusBadGateway)
		return
	}
	sort.SliceStable(choices, func(i, j int) bool {
		return lyricsChoiceScore(choices[i], titleQuery, artistQuery) > lyricsChoiceScore(choices[j], titleQuery, artistQuery)
	})
	writeJSON(w, map[string]any{"choices": choices, "provider_errors": failures})
}

func lyricsChoiceScore(choice lyricsChoice, title, artist string) int {
	score := 0
	choiceTitle, choiceArtist := normalize(choice.Title), normalize(choice.Artist)
	title, artist = normalize(title), normalize(artist)
	if title != "" {
		switch {
		case choiceTitle == title:
			score += 100
		case strings.Contains(choiceTitle, title):
			score += 35
		}
	}
	if artist != "" {
		switch {
		case choiceArtist == artist:
			score += 60
		case strings.Contains(choiceArtist, artist):
			score += 20
		}
	}
	if choice.Provider == "LRCLIB" {
		score += 2
	}
	return score
}

func (s *Server) searchLRCLIB(query string) ([]lyricsChoice, error) {
	var records []struct {
		ID         int64   `json:"id"`
		TrackName  string  `json:"trackName"`
		ArtistName string  `json:"artistName"`
		AlbumName  string  `json:"albumName"`
		Duration   float64 `json:"duration"`
		Instrument bool    `json:"instrumental"`
	}
	endpoint := s.LRCLIBBaseURL + "/api/search?q=" + url.QueryEscape(query)
	if err := s.fetchJSON(endpoint, &records); err != nil {
		return nil, fmt.Errorf("LRCLIB: %w", err)
	}
	choices := make([]lyricsChoice, 0, min(6, len(records)))
	for _, record := range records {
		if record.Instrument || record.TrackName == "" || record.ArtistName == "" {
			continue
		}
		choices = append(choices, lyricsChoice{Provider: "LRCLIB", ID: strconv.FormatInt(record.ID, 10), Title: record.TrackName, Artist: record.ArtistName, Album: record.AlbumName, Duration: record.Duration})
		if len(choices) == 6 {
			break
		}
	}
	return choices, nil
}

func (s *Server) searchLyricsOvh(query string) ([]lyricsChoice, error) {
	var response struct {
		Data []struct {
			ID       int64  `json:"id"`
			Title    string `json:"title"`
			Duration int    `json:"duration"`
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Title string `json:"title"`
			} `json:"album"`
		} `json:"data"`
	}
	endpoint := s.LyricsOvhURL + "/suggest/" + url.PathEscape(query)
	if err := s.fetchJSON(endpoint, &response); err != nil {
		return nil, fmt.Errorf("Lyrics.ovh: %w", err)
	}
	choices := make([]lyricsChoice, 0, min(6, len(response.Data)))
	for _, record := range response.Data {
		if record.Title == "" || record.Artist.Name == "" {
			continue
		}
		choices = append(choices, lyricsChoice{Provider: "Lyrics.ovh", ID: strconv.FormatInt(record.ID, 10), Title: record.Title, Artist: record.Artist.Name, Album: record.Album.Title, Duration: float64(record.Duration)})
		if len(choices) == 6 {
			break
		}
	}
	return choices, nil
}

func (s *Server) HandleLyricsImport(w http.ResponseWriter, r *http.Request) {
	if !authenticatedRequest(w, r) {
		return
	}
	if !s.acquireLyricsRequest(w) {
		return
	}
	defer s.releaseLyricsRequest()
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request lyricsImportRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "Invalid lyrics selection", http.StatusBadRequest)
		return
	}
	request.Title = strings.TrimSpace(request.Title)
	request.Artist = strings.TrimSpace(request.Artist)
	if request.Title == "" || request.Artist == "" || len(request.Title) > 200 || len(request.Artist) > 200 {
		http.Error(w, "Invalid song selection", http.StatusBadRequest)
		return
	}
	var draft lyricsDraft
	var err error
	switch request.Provider {
	case "LRCLIB":
		draft, err = s.importLRCLIB(request)
	case "Lyrics.ovh":
		draft, err = s.importLyricsOvh(request)
	default:
		http.Error(w, "Unknown lyrics provider", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, "Unable to import that lyrics version: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, draft)
}

func (s *Server) importLRCLIB(request lyricsImportRequest) (lyricsDraft, error) {
	id, err := strconv.ParseInt(request.ID, 10, 64)
	if err != nil || id < 1 {
		return lyricsDraft{}, errors.New("invalid LRCLIB result")
	}
	var record struct {
		ID          int64  `json:"id"`
		TrackName   string `json:"trackName"`
		ArtistName  string `json:"artistName"`
		PlainLyrics string `json:"plainLyrics"`
	}
	sourceURL := s.LRCLIBBaseURL + "/api/get/" + strconv.FormatInt(id, 10)
	if err := s.fetchJSON(sourceURL, &record); err != nil {
		return lyricsDraft{}, err
	}
	if strings.TrimSpace(record.PlainLyrics) == "" {
		return lyricsDraft{}, errors.New("the selected result has no plain lyrics")
	}
	if record.ID != id || normalize(record.TrackName) != normalize(request.Title) || normalize(record.ArtistName) != normalize(request.Artist) {
		return lyricsDraft{}, errors.New("the provider result no longer matches the selected recording")
	}
	bpm := s.lookupOriginalBPM(record.TrackName, record.ArtistName, "")
	return lyricsDraft{Title: record.TrackName, Artist: record.ArtistName, OriginalBPM: bpm, SourceURL: sourceURL, SourceProvider: "LRCLIB", Body: structureLyrics(record.TrackName, record.PlainLyrics)}, nil
}

func (s *Server) importLyricsOvh(request lyricsImportRequest) (lyricsDraft, error) {
	choices, err := s.searchLyricsOvh(request.Artist + " " + request.Title)
	if err != nil {
		return lyricsDraft{}, err
	}
	valid := false
	for _, choice := range choices {
		if choice.ID == request.ID && normalize(choice.Title) == normalize(request.Title) && normalize(choice.Artist) == normalize(request.Artist) {
			valid = true
			break
		}
	}
	if !valid {
		return lyricsDraft{}, errors.New("the provider result no longer matches the selected recording")
	}
	endpoint := s.LyricsOvhURL + "/v1/" + url.PathEscape(request.Artist) + "/" + url.PathEscape(request.Title)
	var response struct {
		Lyrics string `json:"lyrics"`
	}
	if err := s.fetchJSON(endpoint, &response); err != nil {
		return lyricsDraft{}, err
	}
	if strings.TrimSpace(response.Lyrics) == "" {
		return lyricsDraft{}, errors.New("the selected result has no lyrics")
	}
	bpm := s.lookupOriginalBPM(request.Title, request.Artist, request.ID)
	return lyricsDraft{Title: request.Title, Artist: request.Artist, OriginalBPM: bpm, SourceURL: endpoint, SourceProvider: "Lyrics.ovh", Body: structureLyrics(request.Title, response.Lyrics)}, nil
}

func (s *Server) lookupOriginalBPM(title, artist, preferredID string) string {
	id := strings.TrimSpace(preferredID)
	if id == "" {
		choices, err := s.searchLyricsOvh(artist + " " + title)
		if err != nil {
			return ""
		}
		for _, choice := range choices {
			if normalize(choice.Title) == normalize(title) && normalize(choice.Artist) == normalize(artist) {
				id = choice.ID
				break
			}
		}
	}
	if id == "" {
		return ""
	}
	var track struct {
		BPM float64 `json:"bpm"`
	}
	if err := s.fetchJSON(s.DeezerBaseURL+"/track/"+url.PathEscape(id), &track); err != nil || track.BPM <= 0 {
		return ""
	}
	return strconv.FormatFloat(track.BPM, 'f', -1, 64)
}

func (s *Server) fetchJSON(endpoint string, destination any) error {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "kgl-songs/1.0 (+private lead-sheet app)")
	response, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid provider response: %w", err)
	}
	return nil
}

func (s *Server) acquireLyricsRequest(w http.ResponseWriter) bool {
	select {
	case s.lyricsSem <- struct{}{}:
		return true
	default:
		http.Error(w, "Too many lyrics requests; try again in a moment", http.StatusTooManyRequests)
		return false
	}
}

func (s *Server) releaseLyricsRequest() {
	<-s.lyricsSem
}

func authenticatedRequest(w http.ResponseWriter, r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("X-ExeDev-UserID")) == "" {
		http.Error(w, "Sign in through exe.dev to search or import lyrics", http.StatusUnauthorized)
		return false
	}
	return true
}

func structureLyrics(title, lyrics string) string {
	clean := strings.ReplaceAll(strings.TrimSpace(lyrics), "\r\n", "\n")
	blocks := regexp.MustCompile(`\n\s*\n+`).Split(clean, -1)
	stanzas := make([][]string, 0, len(blocks))
	sectionLabel := regexp.MustCompile(`(?i)^(?:\[(?:intro|verse|pre[- ]?chorus|chorus|bridge|break|solo|outro)[^]]*\]|(?:intro|verse|pre[- ]?chorus|chorus|bridge|break|solo|outro)(?:\s+\d+)?)$`)
	hasLabels := false
	for _, block := range blocks {
		var lines []string
		for _, line := range strings.Split(strings.TrimSpace(block), "\n") {
			if strings.TrimSpace(line) != "" {
				lines = append(lines, strings.TrimSpace(line))
			}
		}
		if len(lines) == 0 {
			continue
		}
		if sectionLabel.MatchString(lines[0]) {
			hasLabels = true
		}
		stanzas = append(stanzas, lines)
	}
	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	if hasLabels {
		for _, lines := range stanzas {
			if sectionLabel.MatchString(lines[0]) {
				b.WriteString("### " + strings.Trim(lines[0], "[]") + "\n")
				lines = lines[1:]
			} else {
				b.WriteString("### Section\n")
			}
			if len(lines) > 0 {
				b.WriteString(preserveLeadSheetLineBreaks(strings.Join(lines, "\n")) + "\n\n")
			} else {
				b.WriteByte('\n')
			}
		}
		return strings.TrimSpace(b.String()) + "\n"
	}

	chorusPattern := repeatedLyricSequence(stanzas)
	type section struct {
		chorus bool
		lines  []string
	}
	var sections []section
	for _, lines := range stanzas {
		start := findLyricSequence(lines, chorusPattern)
		if start < 0 {
			sections = append(sections, section{lines: lines})
			continue
		}
		if start > 0 {
			sections = append(sections, section{lines: lines[:start]})
		}
		end := start + len(chorusPattern)
		chorusLines := append([]string(nil), lines[start:end]...)
		if trailing := len(lines) - end; trailing > 0 && trailing <= 2 {
			chorusLines = append(chorusLines, lines[end:]...)
			end = len(lines)
		}
		sections = append(sections, section{chorus: true, lines: chorusLines})
		if end < len(lines) {
			sections = append(sections, section{lines: lines[end:]})
		}
	}
	verse := 0
	for i, section := range sections {
		switch {
		case section.chorus:
			b.WriteString("### Chorus\n")
		case i == len(sections)-1 && len(section.lines) <= 2:
			b.WriteString("### Outro\n")
		default:
			verse++
			b.WriteString("### Verse " + strconv.Itoa(verse) + "\n")
		}
		b.WriteString(preserveLeadSheetLineBreaks(strings.Join(section.lines, "\n")) + "\n\n")
	}
	return strings.TrimSpace(b.String()) + "\n"
}

func repeatedLyricSequence(stanzas [][]string) []string {
	maxLength := 0
	for _, stanza := range stanzas {
		if len(stanza) > maxLength {
			maxLength = len(stanza)
		}
	}
	if maxLength > 8 {
		maxLength = 8
	}
	for length := maxLength; length >= 3; length-- {
		for stanzaIndex, stanza := range stanzas {
			for start := 0; start+length <= len(stanza); start++ {
				candidate := stanza[start : start+length]
				matchedStanzas := 1
				for otherIndex := stanzaIndex + 1; otherIndex < len(stanzas); otherIndex++ {
					if findLyricSequence(stanzas[otherIndex], candidate) >= 0 {
						matchedStanzas++
					}
				}
				if matchedStanzas >= 2 {
					return append([]string(nil), candidate...)
				}
			}
		}
	}
	return nil
}

func findLyricSequence(lines, sequence []string) int {
	if len(sequence) == 0 || len(sequence) > len(lines) {
		return -1
	}
	for start := 0; start+len(sequence) <= len(lines); start++ {
		match := true
		for i := range sequence {
			if normalize(lines[start+i]) != normalize(sequence[i]) {
				match = false
				break
			}
		}
		if match {
			return start
		}
	}
	return -1
}

func (s *Server) HandleSong(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	song := s.songsByID[r.PathValue("id")]
	s.mu.RUnlock()
	if song == nil {
		http.NotFound(w, r)
		return
	}
	s.render(w, r, "song.html", pageData{Title: song.Title, Song: song, UserEmail: r.Header.Get("X-ExeDev-Email")})
}
func (s *Server) HandleSet(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	set := s.setsByID[r.PathValue("id")]
	s.mu.RUnlock()
	if set == nil {
		http.NotFound(w, r)
		return
	}
	s.render(w, r, "set.html", pageData{Title: set.Title, Set: set, UserEmail: r.Header.Get("X-ExeDev-Email")})
}
func (s *Server) HandleLiveSet(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	set := s.setsByID[r.PathValue("id")]
	s.mu.RUnlock()
	if set == nil {
		http.NotFound(w, r)
		return
	}
	s.render(w, r, "live.html", pageData{Title: set.Title, Set: set})
}
func (s *Server) HandleSongJSON(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	song := s.songsByID[r.PathValue("id")]
	s.mu.RUnlock()
	if song == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, map[string]any{"id": song.ID, "title": song.Title, "artist": song.Artist, "key": song.Key, "bpm": song.BPM, "original_key": song.OriginalKey, "original_bpm": song.OriginalBPM, "source_url": song.SourceURL, "source_provider": song.SourceProvider, "path": song.Path, "hash": song.Hash, "html": string(song.HTML)})
}

func (s *Server) HandleCatalog(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	songs := append([]*Song(nil), s.songs...)
	s.mu.RUnlock()
	writeJSON(w, songs)
}
func (s *Server) HandleOfflineManifest(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	set := s.setsByID[r.PathValue("id")]
	s.mu.RUnlock()
	if set == nil {
		http.NotFound(w, r)
		return
	}
	urls := []string{"/", "/sets/" + set.ID, "/sets/" + set.ID + "/live", "/api/catalog", "/static/style.css", "/static/app.js", "/static/icon.svg", "/manifest.webmanifest"}
	for _, item := range set.Items {
		urls = append(urls, "/song/"+item.Song.ID)
	}
	writeJSON(w, map[string]any{"set": set.ID, "hash": set.Hash, "urls": urls})
}
func (s *Server) HandleReindex(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(r.Header.Get("X-ExeDev-UserID")) == "" {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	if err := s.Reindex(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) render(w http.ResponseWriter, r *http.Request, name string, data pageData) {
	s.renderStatus(w, r, name, data, http.StatusOK)
}

func (s *Server) renderStatus(w http.ResponseWriter, r *http.Request, name string, data pageData, status int) {
	s.mu.RLock()
	data.SongCount = len(s.songs)
	data.SetCount = len(s.sets)
	data.ShelleyURL = shelleyNewConversationURL(s.Hostname)
	s.mu.RUnlock()
	setSecurityHeaders(w)
	path := filepath.Join(s.TemplatesDir, name)
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		http.Error(w, "template error", 500)
		slog.Error("parse template", "error", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := tmpl.Execute(w, data); err != nil {
		slog.Error("execute template", "error", err)
	}
}
func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.HandleHome)
	mux.HandleFunc("GET /songs", s.HandleHome)
	mux.HandleFunc("GET /songs/new", s.HandleNewSong)
	mux.HandleFunc("POST /songs", s.HandleCreateSong)
	mux.HandleFunc("GET /set-lists", s.HandleSetLists)
	mux.HandleFunc("GET /song/{id}", s.HandleSong)
	mux.HandleFunc("GET /sets/{id}", s.HandleSet)
	mux.HandleFunc("GET /sets/{id}/live", s.HandleLiveSet)
	mux.HandleFunc("GET /api/lyrics/search", s.HandleLyricsSearch)
	mux.HandleFunc("POST /api/lyrics/import", s.HandleLyricsImport)
	mux.HandleFunc("GET /api/catalog", s.HandleCatalog)
	mux.HandleFunc("GET /api/songs/{id}", s.HandleSongJSON)
	mux.HandleFunc("GET /api/offline/sets/{id}", s.HandleOfflineManifest)
	mux.HandleFunc("POST /api/reindex", s.HandleReindex)
	mux.HandleFunc("GET /manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/manifest+json")
		http.ServeFile(w, r, filepath.Join(s.StaticDir, "manifest.webmanifest"))
	})
	mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Service-Worker-Allowed", "/")
		http.ServeFile(w, r, filepath.Join(s.StaticDir, "sw.js"))
	})
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(s.StaticDir))))
	slog.Info("starting songs server", "addr", addr, "repo", s.RepoRoot)
	return http.ListenAndServe(addr, mux)
}

func preserveLeadSheetLineBreaks(body string) string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	inFence := false
	isBlock := func(line string) bool {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ">") || strings.HasPrefix(trimmed, "|") || strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			return true
		}
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
			return true
		}
		for i := 0; i < len(trimmed) && trimmed[i] >= '0' && trimmed[i] <= '9'; i++ {
			if i+1 < len(trimmed) && (trimmed[i+1] == '.' || trimmed[i+1] == ')') {
				return true
			}
		}
		return false
	}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence || isBlock(line) || strings.HasSuffix(line, "  ") || strings.HasSuffix(line, "\\") || i+1 >= len(lines) {
			continue
		}
		if strings.TrimSpace(lines[i+1]) != "" && !isBlock(lines[i+1]) {
			lines[i] = strings.TrimRight(line, " \t") + "  "
		}
	}
	return strings.Join(lines, "\n")
}

func shelleyNewConversationURL(hostname string) string {
	host := strings.TrimSpace(strings.Split(hostname, ":")[0])
	host = strings.TrimSuffix(host, ".exe.xyz")
	if host == "" {
		host = "localhost"
	}
	return "https://" + host + ".shelley.exe.xyz/new"
}

func buildSongMarkdown(id, title, artist, key, bpm, originalKey, originalBPM, sourceProvider, sourceURL, body string) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("schema_version: 1\n")
	b.WriteString("id: " + yamlString(id) + "\n")
	b.WriteString("title: " + yamlString(title) + "\n")
	if artist != "" {
		b.WriteString("artist: " + yamlString(artist) + "\n")
	}
	if key != "" {
		b.WriteString("performance_key: " + yamlString(key) + "\n")
	}
	if bpm != "" {
		b.WriteString("bpm: " + yamlString(bpm) + "\n")
	}
	if originalKey != "" {
		b.WriteString("original_key: " + yamlString(originalKey) + "\n")
	}
	if originalBPM != "" {
		b.WriteString("original_bpm: " + yamlString(originalBPM) + "\n")
	}
	provenanceStatus := "user-supplied"
	if sourceProvider != "" {
		provenanceStatus = "provider-imported-pending-review"
	}
	b.WriteString("provenance_status: " + provenanceStatus + "\n")
	if sourceProvider != "" {
		b.WriteString("source_provider: " + yamlString(sourceProvider) + "\n")
	}
	if sourceURL != "" {
		b.WriteString("source_url: " + yamlString(sourceURL) + "\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimSpace(body))
	b.WriteByte('\n')
	return b.String()
}

func yamlString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func gitCommand(root string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func titleFromMarkdown(s string) string {
	m := h1Pattern.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	t := strings.TrimSpace(m[1])
	if i := strings.Index(t, " {short="); i >= 0 {
		t = t[:i]
	}
	return t
}
func metadataValue(s, key string) string {
	if !strings.HasPrefix(s, "---\n") {
		return ""
	}
	end := strings.Index(s[4:], "\n---")
	if end < 0 {
		return ""
	}
	for _, line := range strings.Split(s[4:4+end], "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
			return strings.Trim(strings.TrimSpace(parts[1]), "\"'")
		}
	}
	return ""
}
func slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
func normalize(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func hashBytes(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func mustRel(root, path string) string {
	r, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(r)
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
}
