package srv

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"songs.exe.dev/db"
)

type Song struct {
	ID       string        `json:"id"`
	Path     string        `json:"path"`
	Title    string        `json:"title"`
	HTML     template.HTML `json:"-"`
	Hash     string        `json:"hash"`
	Modified time.Time     `json:"modified"`
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
	DB           *sql.DB
	Hostname     string
	RepoRoot     string
	TemplatesDir string
	StaticDir    string
	ApexPath     string

	mu          sync.RWMutex
	songs       []*Song
	songsByID   map[string]*Song
	songsByPath map[string]*Song
	sets        []*SetList
	setsByID    map[string]*SetList
}

type pageData struct {
	Title     string
	UserEmail string
	Songs     []*Song
	Sets      []*SetList
	Song      *Song
	Set       *SetList
	BuildTime string
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
		TemplatesDir: filepath.Join(baseDir, "templates"),
		StaticDir:    filepath.Join(baseDir, "static"), ApexPath: apexPath,
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
		title := titleFromMarkdown(string(body))
		if title == "" {
			title = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		}
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
		song := &Song{ID: id, Path: rel, Title: title, HTML: template.HTML(rendered), Hash: hash}
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
	sets := append([]*SetList(nil), s.sets...)
	s.mu.RUnlock()
	s.render(w, r, "home.html", pageData{Title: "Songs", UserEmail: r.Header.Get("X-ExeDev-Email"), Songs: songs, Sets: sets, BuildTime: time.Now().Format(time.RFC3339)})
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
	writeJSON(w, map[string]any{"id": song.ID, "title": song.Title, "path": song.Path, "hash": song.Hash, "html": string(song.HTML)})
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
	setSecurityHeaders(w)
	path := filepath.Join(s.TemplatesDir, name)
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		http.Error(w, "template error", 500)
		slog.Error("parse template", "error", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.Execute(w, data); err != nil {
		slog.Error("execute template", "error", err)
	}
}
func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.HandleHome)
	mux.HandleFunc("GET /song/{id}", s.HandleSong)
	mux.HandleFunc("GET /sets/{id}", s.HandleSet)
	mux.HandleFunc("GET /sets/{id}/live", s.HandleLiveSet)
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
