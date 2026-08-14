// Package v2author provides the authenticated, review-only online boundary for
// V2 lead-sheet validation, provider import, and model-assisted suggestions.
// It deliberately has no store, Git, sync, or publication dependency.
package v2author

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"songs.exe.dev/internal/v2auth"
)

const (
	PathPrefix              = "/api/v2/author"
	MaxSourceBytes          = 1 << 20
	maxRequestBytes         = 8 << 20
	maxProviderResponse     = 1 << 20
	maxModelRequest         = 8 << 20
	maxModelResponse        = 8 << 20
	maxApexOutput           = 8 << 20
	requestTimeout          = 15 * time.Second
	providerWorkflowTimeout = 25 * time.Second
	apexTimeout             = 10 * time.Second
	modelTimeout            = 20 * time.Second
)

// Config contains only trusted process configuration. OwnerID and
// ForwardedHost are exact v2auth matches. ProvidersEnabled and ShelleyEnabled
// are independent, disabled-by-default online capability gates.
type Config struct {
	OwnerID       string
	ForwardedHost string
	ApexPath      string
	HTTPClient    *http.Client

	LRCLIBBaseURL    string
	LyricsOvhBaseURL string
	DeezerBaseURL    string
	LLMBaseURL       string
	LLMModel         string

	ProvidersEnabled bool
	ShelleyEnabled   bool
}

// Handler is an http.Handler. It retains no authored source after a request and
// has no durable write capability.
type Handler struct {
	auth        v2auth.Config
	apexPath    string
	client      *http.Client
	lrclib      string
	lyricsOvh   string
	deezer      string
	llm         string
	model       string
	providers   bool
	shelley     bool
	providerSem chan struct{}
	modelSem    chan struct{}
	apexSem     chan struct{}
}

// New validates trusted configuration and constructs the authoring helper.
func New(cfg Config) (*Handler, error) {
	if !validOwner(cfg.OwnerID) {
		return nil, errors.New("v2author: invalid owner ID")
	}
	if !v2auth.ValidForwardedHost(cfg.ForwardedHost) {
		return nil, errors.New("v2author: invalid forwarded host")
	}
	apexPath := strings.TrimSpace(cfg.ApexPath)
	if apexPath == "" {
		return nil, errors.New("v2author: Apex executable is required")
	}
	var err error
	if !strings.ContainsRune(apexPath, os.PathSeparator) {
		apexPath, err = exec.LookPath(apexPath)
		if err != nil {
			return nil, fmt.Errorf("v2author: find Apex executable: %w", err)
		}
	}
	info, err := os.Stat(apexPath)
	if err != nil {
		return nil, fmt.Errorf("v2author: stat Apex executable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return nil, errors.New("v2author: Apex path is not an executable regular file")
	}

	lrclib, err := cleanBaseURL(cfg.LRCLIBBaseURL, cfg.ProvidersEnabled, "LRCLIB")
	if err != nil {
		return nil, err
	}
	lyricsOvh, err := cleanBaseURL(cfg.LyricsOvhBaseURL, cfg.ProvidersEnabled, "Lyrics.ovh")
	if err != nil {
		return nil, err
	}
	deezer, err := cleanBaseURL(cfg.DeezerBaseURL, cfg.ProvidersEnabled, "Deezer")
	if err != nil {
		return nil, err
	}
	llm, err := cleanBaseURL(cfg.LLMBaseURL, cfg.ShelleyEnabled, "LLM")
	if err != nil {
		return nil, err
	}
	if cfg.ShelleyEnabled && !validSingleLine(cfg.LLMModel, 200, false) {
		return nil, errors.New("v2author: invalid LLM model")
	}

	client := &http.Client{}
	if cfg.HTTPClient != nil {
		clone := *cfg.HTTPClient
		client = &clone
	}
	if client.Timeout <= 0 || client.Timeout > requestTimeout {
		client.Timeout = requestTimeout
	}
	// Provider and model base URLs are trusted configuration, but redirects are
	// not: following one could silently move source material to another origin.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	return &Handler{
		auth:     v2auth.Config{OwnerID: cfg.OwnerID, ForwardedHost: cfg.ForwardedHost},
		apexPath: apexPath, client: client,
		lrclib: lrclib, lyricsOvh: lyricsOvh, deezer: deezer,
		llm: llm, model: cfg.LLMModel,
		providers: cfg.ProvidersEnabled, shelley: cfg.ShelleyEnabled,
		providerSem: make(chan struct{}, 4), modelSem: make(chan struct{}, 1), apexSem: make(chan struct{}, 2),
	}, nil
}

func validOwner(owner string) bool {
	return owner != "" && len(owner) <= 255 && utf8.ValidString(owner) && strings.TrimSpace(owner) == owner && !strings.ContainsAny(owner, "\x00\r\n")
}

func cleanBaseURL(raw string, required bool, label string) (string, error) {
	if raw == "" && !required {
		return "", nil
	}
	if raw == "" || strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("v2author: invalid %s base URL", label)
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("v2author: invalid %s base URL", label)
	}
	return strings.TrimRight(raw, "/"), nil
}

func (h *Handler) Handler() http.Handler { return h }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	if r == nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication through the secure exe.dev proxy is required")
		return
	}
	if _, err := v2auth.ExtractPrincipal(r, h.auth); err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication through the secure exe.dev proxy is required")
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch path {
	case PathPrefix + "/validate":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "validate does not accept query parameters")
			return
		}
		if !h.requireSameOrigin(w, r) {
			return
		}
		h.handleValidate(w, r)
	case PathPrefix + "/providers/search":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		if !h.providers {
			capabilityDisabled(w)
			return
		}
		h.handleProviderSearch(w, r)
	case PathPrefix + "/providers/import":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "provider import does not accept query parameters")
			return
		}
		if !h.requireSameOrigin(w, r) {
			return
		}
		if !h.providers {
			capabilityDisabled(w)
			return
		}
		h.handleProviderImport(w, r)
	case PathPrefix + "/shelley/suggest":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "Shelley suggest does not accept query parameters")
			return
		}
		if !h.requireSameOrigin(w, r) {
			return
		}
		if !h.shelley {
			capabilityDisabled(w)
			return
		}
		h.handleShelleySuggest(w, r)
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "authoring resource not found")
	}
}

func (h *Handler) requireSameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
		writeError(w, http.StatusForbidden, "CROSS_SITE_REQUEST", "cross-site mutation requests are not allowed")
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host != h.auth.ForwardedHost || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		writeError(w, http.StatusForbidden, "CROSS_SITE_REQUEST", "cross-site mutation requests are not allowed")
		return false
	}
	return true
}

func acquire(ch chan struct{}) bool {
	select {
	case ch <- struct{}{}:
		return true
	default:
		return false
	}
}
func release(ch chan struct{}) { <-ch }

func setHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", v2auth.UserHeader)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	setHeaders(w)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"schema_version": "1", "error": map[string]string{"code": code, "message": message}})
}
func methodNotAllowed(w http.ResponseWriter, method string) {
	w.Header().Set("Allow", method)
	writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method is not supported")
}
func capabilityDisabled(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "CAPABILITY_DISABLED", "online authoring capability is disabled")
}

func requireJSON(w http.ResponseWriter, r *http.Request, limit int64, dst any) bool {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if contentType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "application/json is required")
		return false
	}
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body is too large")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body is too large")
		return false
	}
	if len(body) == 0 || duplicateJSONKey(body) {
		code := "INVALID_JSON"
		if len(body) > 0 {
			code = "DUPLICATE_FIELD"
		}
		writeError(w, http.StatusBadRequest, code, "request body is invalid JSON")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		code := "INVALID_JSON"
		if strings.Contains(err.Error(), "unknown field") {
			code = "UNKNOWN_FIELD"
		}
		writeError(w, http.StatusBadRequest, code, "request body is invalid JSON")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		writeError(w, http.StatusBadRequest, "TRAILING_JSON", "request body is invalid JSON")
		return false
	}
	return true
}

// duplicateJSONKey rejects duplicate object keys at every nesting level. A
// malformed document is also treated as invalid by the caller's typed decode.
func duplicateJSONKey(raw []byte) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var walk func() (bool, error)
	walk = func() (bool, error) {
		tok, err := dec.Token()
		if err != nil {
			return false, err
		}
		d, ok := tok.(json.Delim)
		if !ok {
			return false, nil
		}
		switch d {
		case '{':
			seen := map[string]bool{}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return false, err
				}
				name, ok := key.(string)
				if !ok {
					return false, errors.New("non-string key")
				}
				if seen[name] {
					return true, nil
				}
				seen[name] = true
				dup, err := walk()
				if dup || err != nil {
					return dup, err
				}
			}
			_, err = dec.Token()
			return false, err
		case '[':
			for dec.More() {
				dup, err := walk()
				if dup || err != nil {
					return dup, err
				}
			}
			_, err = dec.Token()
			return false, err
		default:
			return false, errors.New("invalid delimiter")
		}
	}
	dup, err := walk()
	if err != nil {
		return false
	}
	return dup
}
