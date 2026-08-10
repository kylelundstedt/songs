package v2bootstrap

import (
	"encoding/json"
	"net/http"
	"strings"
)

type apiHandler struct{ snapshot *Snapshot }

type errorEnvelope struct {
	SchemaVersion string `json:"schema_version"`
	Error         struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setAPIHeaders(w)
	if strings.TrimSpace(r.Header.Get("X-ExeDev-UserID")) == "" {
		writeAPIError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication required")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeAPIError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "only GET is supported")
		return
	}
	if r.URL.Path == "/api/v2/bootstrap/manifest" {
		w.Header().Set("ETag", h.snapshot.manifestETag)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(h.snapshot.manifest)
		return
	}
	prefix := "/api/v2/bootstrap/" + h.snapshot.generation + "/chunks/"
	if strings.HasPrefix(r.URL.Path, prefix) {
		name := strings.TrimPrefix(r.URL.Path, prefix)
		if name != "" && !strings.Contains(name, "/") {
			if raw, ok := h.snapshot.chunks[name]; ok {
				w.Header().Set("ETag", h.snapshot.chunkETags[name])
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(raw)
				return
			}
		}
	}
	writeAPIError(w, http.StatusNotFound, "NOT_FOUND", "bootstrap resource not found")
}

func setAPIHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Add("Vary", "X-ExeDev-UserID")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	response := errorEnvelope{SchemaVersion: "1"}
	response.Error.Code = code
	response.Error.Message = message
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}
