package v2shell

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

const (
	expectedAssetManifestSHA256 = "63e6476520a1f71c5b8b652d14d7ede1cf1ce9f76d50178037103b687a3e49cf"
	expectedBootstrapSHA256     = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
	expectedRelease             = "shell-e538fc0fbcd4a61ce69cfe1a"
)

//go:embed data/* data/assets/*
var embedded embed.FS

type assetRecord struct {
	Path         string `json:"path"`
	Bytes        int    `json:"bytes"`
	SHA256       string `json:"sha256"`
	ContentType  string `json:"content_type"`
	CacheControl string `json:"cache_control"`
}

type assetManifest struct {
	SchemaVersion           string        `json:"schema_version"`
	Kind                    string        `json:"kind"`
	Release                 string        `json:"release"`
	BootstrapManifestSHA256 string        `json:"bootstrap_manifest_sha256"`
	AcceptedBootstrapSHA256 []string      `json:"accepted_bootstrap_manifest_sha256"`
	CachePrefix             string        `json:"cache_prefix"`
	IndexedDBName           string        `json:"indexeddb_name"`
	Assets                  []assetRecord `json:"assets"`
	Verification            struct {
		OutputSHA256 string `json:"output_sha256"`
	} `json:"verification"`
}

type asset struct {
	body         []byte
	contentType  string
	cacheControl string
	etag         string
}

type Shell struct {
	api     http.Handler
	assets  map[string]asset
	release string
}

func LoadEmbedded(api http.Handler, bootstrapManifestSHA256 string) (*Shell, error) {
	return Load(embedded, api, bootstrapManifestSHA256)
}

func Load(files fs.FS, api http.Handler, bootstrapManifestSHA256 string) (*Shell, error) {
	if api == nil {
		return nil, errors.New("V2 API handler is required")
	}
	rawManifest, err := fs.ReadFile(files, "data/asset-manifest.json")
	if err != nil {
		return nil, fmt.Errorf("read shell asset manifest: %w", err)
	}
	if digest(rawManifest) != expectedAssetManifestSHA256 {
		return nil, errors.New("shell asset manifest does not match the reviewed trust anchor")
	}
	var manifest assetManifest
	decoder := json.NewDecoder(bytes.NewReader(rawManifest))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decode shell asset manifest: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("shell asset manifest has trailing JSON data")
	}
	if manifest.SchemaVersion != "1" || manifest.Kind != "songs-v2.shell.assets" || manifest.Release != expectedRelease || manifest.BootstrapManifestSHA256 != expectedBootstrapSHA256 || len(manifest.AcceptedBootstrapSHA256) != 1 || manifest.AcceptedBootstrapSHA256[0] != expectedBootstrapSHA256 || bootstrapManifestSHA256 != expectedBootstrapSHA256 || manifest.CachePrefix != "songs-v2-shell-" || manifest.IndexedDBName != "songs-v2" {
		return nil, errors.New("shell identity or namespace drift")
	}

	actual := map[string]bool{}
	if err := fs.WalkDir(files, "data", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() && path != "data/asset-manifest.json" {
			actual[strings.TrimPrefix(path, "data/")] = true
		}
		return nil
	}); err != nil {
		return nil, fmt.Errorf("enumerate shell assets: %w", err)
	}
	assets := make(map[string]asset, len(manifest.Assets))
	for _, record := range manifest.Assets {
		if record.Path == "" || strings.HasPrefix(record.Path, "/") || strings.Contains(record.Path, "..") || assets["/"+record.Path].body != nil {
			return nil, fmt.Errorf("invalid or duplicate shell asset path %q", record.Path)
		}
		if !actual[record.Path] {
			return nil, fmt.Errorf("missing shell asset %q", record.Path)
		}
		delete(actual, record.Path)
		raw, err := fs.ReadFile(files, "data/"+record.Path)
		if err != nil {
			return nil, fmt.Errorf("read shell asset %q: %w", record.Path, err)
		}
		if len(raw) != record.Bytes || digest(raw) != record.SHA256 {
			return nil, fmt.Errorf("shell asset hash mismatch: %s", record.Path)
		}
		assets["/"+record.Path] = asset{body: bytes.Clone(raw), contentType: record.ContentType, cacheControl: record.CacheControl, etag: `"` + record.SHA256 + `"`}
	}
	if len(actual) != 0 {
		for path := range actual {
			return nil, fmt.Errorf("unreferenced shell asset %q", path)
		}
	}
	if _, ok := assets["/index.html"]; !ok {
		return nil, errors.New("shell index is missing")
	}
	return &Shell{api: api, assets: assets, release: manifest.Release}, nil
}

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *Shell) Release() string { return s.release }

func (s *Shell) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2" || strings.HasPrefix(r.URL.Path, "/api/v2/") {
			s.api.ServeHTTP(w, r)
			return
		}
		setSecurityHeaders(w)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		value, ok := s.assets[path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", value.contentType)
		w.Header().Set("Cache-Control", value.cacheControl)
		w.Header().Set("ETag", value.etag)
		w.Header().Set("Content-Length", strconv.Itoa(len(value.body)))
		if path == "/sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(value.body)
		}
	})
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
}
