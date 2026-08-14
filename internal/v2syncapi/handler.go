// Package v2syncapi adapts the durable v2sync store to the authenticated HTTP API.
package v2syncapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"songs.exe.dev/internal/v2auth"
	"songs.exe.dev/internal/v2sync"
)

const (
	PathPrefix  = "/api/v2/sync"
	MaxBodySize = 8 << 20
)

// Config is the trusted HTTP boundary configuration. OwnerID and ForwardedHost
// are exact matches; neither is accepted from a request body or query string.
type Config struct {
	Store                  *v2sync.Store
	OwnerID                string
	ForwardedHost          string
	MasterKey              []byte
	EnforceDocumentGates   bool
	SetListWritesEnabled   bool
	LeadSheetWritesEnabled bool
}

// Handler serves the JSON-only sync API.
type Handler struct {
	store                  *v2sync.Store
	auth                   v2auth.Config
	key                    []byte
	enforceDocumentGates   bool
	setListWritesEnabled   bool
	leadSheetWritesEnabled bool
}

// New constructs a sync API handler. MasterKey must contain at least 32 bytes.
func New(store *v2sync.Store, cfg Config) (*Handler, error) {
	if store == nil {
		return nil, errors.New("v2syncapi: nil store")
	}
	if len(cfg.MasterKey) < 32 {
		return nil, v2auth.ErrInvalidMasterKey
	}
	if !validOwnerConfig(cfg.OwnerID) {
		return nil, errors.New("v2syncapi: invalid owner ID")
	}
	if !v2auth.ValidForwardedHost(cfg.ForwardedHost) {
		return nil, errors.New("v2syncapi: invalid forwarded host")
	}
	return &Handler{
		store:                  store,
		auth:                   v2auth.Config{OwnerID: cfg.OwnerID, ForwardedHost: cfg.ForwardedHost},
		key:                    append([]byte(nil), cfg.MasterKey...),
		enforceDocumentGates:   cfg.EnforceDocumentGates,
		setListWritesEnabled:   cfg.SetListWritesEnabled,
		leadSheetWritesEnabled: cfg.LeadSheetWritesEnabled,
	}, nil
}

func validOwnerConfig(owner string) bool {
	return owner != "" && len(owner) <= 255 && utf8.ValidString(owner) && strings.TrimSpace(owner) == owner && !strings.ContainsAny(owner, "\x00\r\n")
}

func (h *Handler) Handler() http.Handler { return h }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	if r == nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication through the secure exe.dev proxy is required")
		return
	}
	principal, err := v2auth.ExtractPrincipal(r, h.auth)
	if err != nil {
		writeMappedError(w, err)
		return
	}

	path := strings.TrimSuffix(r.URL.Path, "/")
	if path == PathPrefix || !strings.HasPrefix(path, PathPrefix+"/") {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "sync resource not found")
		return
	}
	if path == PathPrefix+"/devices/register" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.register(w, r, principal.OwnerID)
		return
	}

	// Every endpoint other than registration requires both trusted proxy
	// identity and the dedicated device credential headers.
	cred, err := v2auth.ParseDeviceCredential(r)
	if err != nil || len(cred.Token) > 4096 {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "owner/device authorization failed")
		return
	}
	if err = h.store.AuthenticateDevice(principal.OwnerID, cred.DeviceID, cred.Token); err != nil {
		writeMappedError(w, err)
		return
	}

	switch {
	case path == PathPrefix+"/operations/apply":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.apply(w, r, principal.OwnerID, cred.DeviceID)
	case path == PathPrefix+"/ack":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		h.ack(w, r, principal.OwnerID, cred.DeviceID)
	case path == PathPrefix+"/pull":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		h.pull(w, r, principal.OwnerID, cred.DeviceID)
	case path == PathPrefix+"/snapshot":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		h.snapshot(w, r, principal.OwnerID, cred.DeviceID)
	case path == PathPrefix+"/diagnostics":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "diagnostics does not accept query parameters")
			return
		}
		h.diagnostics(w, principal.OwnerID, cred.DeviceID)
	case path == PathPrefix+"/health":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "health does not accept query parameters")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"protocol_version": v2sync.ProtocolVersion, "status": "ok"})
	case strings.HasPrefix(path, PathPrefix+"/devices/") && strings.HasSuffix(path, "/revoke"):
		h.revoke(w, r, principal.OwnerID, cred.DeviceID, path)
	case strings.HasPrefix(path, PathPrefix+"/conflicts/") && strings.HasSuffix(path, "/resolve"):
		h.resolve(w, r, principal.OwnerID, cred.DeviceID, path)
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "sync resource not found")
	}
}

type registrationRequest struct {
	ProtocolVersion string `json:"protocol_version"`
	DeviceID        string `json:"device_id"`
	RegistrationID  string `json:"registration_id"`
	Name            string `json:"name"`
}

var conflictPathRE = regexp.MustCompile(`^` + regexp.QuoteMeta(PathPrefix) + `/conflicts/(conf-[a-f0-9]{24})/resolve$`)

type registrationResponse struct {
	ProtocolVersion string `json:"protocol_version"`
	OwnerID         string `json:"owner_id"`
	DeviceID        string `json:"device_id"`
	RegistrationID  string `json:"registration_id"`
	Name            string `json:"name"`
	Status          string `json:"status"`
	Token           string `json:"token"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request, owner string) {
	var in registrationRequest
	if !requireJSONBody(w, r, &in, "protocol_version", "device_id", "registration_id", "name") {
		return
	}
	if in.ProtocolVersion != v2sync.ProtocolVersion || !v2sync.ValidStableID(in.DeviceID) || !v2sync.ValidStableID(in.RegistrationID) || in.Name == "" {
		writeError(w, http.StatusBadRequest, "INVALID_ENVELOPE", "registration envelope is invalid")
		return
	}
	token, err := v2auth.GenerateDeviceToken(h.key, owner, in.DeviceID, in.RegistrationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "request could not be completed")
		return
	}
	reg, err := h.store.RegisterDevice(owner, in.DeviceID, in.RegistrationID, in.Name, v2auth.HashDeviceToken(token))
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, registrationResponse{v2sync.ProtocolVersion, reg.OwnerID, reg.DeviceID, reg.RegistrationID, reg.Name, reg.Status, token})
}

type applyRequest struct {
	ProtocolVersion string          `json:"protocol_version"`
	DeviceID        string          `json:"device_id"`
	OperationID     string          `json:"operation_id"`
	OperationKind   string          `json:"operation_kind"`
	DocumentID      string          `json:"document_id"`
	BaseRevisionID  string          `json:"base_revision_id"`
	Title           string          `json:"title"`
	Payload         json.RawMessage `json:"payload"`
	PayloadSHA256   string          `json:"payload_sha256"`
	ClientCursor    int64           `json:"client_cursor"`
}

func (h *Handler) permitDocumentWrite(w http.ResponseWriter, payload json.RawMessage) bool {
	if !h.enforceDocumentGates {
		return true
	}
	var header struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(payload, &header); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_ENVELOPE", "publication payload kind is invalid")
		return false
	}
	allowed := header.Kind == "set-list" && h.setListWritesEnabled || header.Kind == "lead-sheet" && h.leadSheetWritesEnabled
	if !allowed {
		writeError(w, http.StatusForbidden, "WRITE_DISABLED", "document write capability is disabled")
		return false
	}
	return true
}

func (h *Handler) apply(w http.ResponseWriter, r *http.Request, owner, device string) {
	var in applyRequest
	if !requireJSONBody(w, r, &in, "protocol_version", "device_id", "operation_id", "operation_kind", "document_id", "base_revision_id", "title", "payload", "payload_sha256", "client_cursor") {
		return
	}
	if in.DeviceID != device {
		writeError(w, http.StatusBadRequest, "INVALID_ENVELOPE", "device ID does not match the authenticated device")
		return
	}
	if !h.permitDocumentWrite(w, in.Payload) {
		return
	}
	o, err := h.store.Apply(v2sync.ApplyEnvelope{
		ProtocolVersion: in.ProtocolVersion, OwnerID: owner, DeviceID: device,
		OperationID: in.OperationID, OperationKind: in.OperationKind, DocumentID: in.DocumentID,
		BaseRevisionID: in.BaseRevisionID, Title: in.Title, Payload: in.Payload,
		PayloadSHA256: in.PayloadSHA256, ClientCursor: in.ClientCursor,
	})
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

type resolveRequest struct {
	ProtocolVersion string          `json:"protocol_version"`
	DeviceID        string          `json:"device_id"`
	OperationID     string          `json:"operation_id"`
	OperationKind   string          `json:"operation_kind"`
	DocumentID      string          `json:"document_id"`
	BaseRevisionID  string          `json:"base_revision_id"`
	Title           string          `json:"title"`
	Payload         json.RawMessage `json:"payload"`
	PayloadSHA256   string          `json:"payload_sha256"`
	ClientCursor    int64           `json:"client_cursor"`
}

func (h *Handler) resolve(w http.ResponseWriter, r *http.Request, owner, device, path string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	matches := conflictPathRE.FindStringSubmatch(path)
	if len(matches) != 2 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "sync resource not found")
		return
	}
	id := matches[1]
	var in resolveRequest
	if !requireJSONBody(w, r, &in, "protocol_version", "device_id", "operation_id", "operation_kind", "document_id", "base_revision_id", "title", "payload", "payload_sha256", "client_cursor") {
		return
	}
	if in.DeviceID != device {
		writeError(w, http.StatusBadRequest, "INVALID_ENVELOPE", "device ID does not match the authenticated device")
		return
	}
	if h.enforceDocumentGates {
		expectedKind, err := h.store.ConflictDocumentKind(owner, device, id)
		if err != nil {
			writeMappedError(w, err)
			return
		}
		var header struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(in.Payload, &header); err != nil || header.Kind != expectedKind {
			writeError(w, http.StatusBadRequest, "INVALID_ENVELOPE", "resolution payload kind does not match the conflict")
			return
		}
	}
	if !h.permitDocumentWrite(w, in.Payload) {
		return
	}
	o, err := h.store.Resolve(v2sync.ResolveEnvelope{
		ProtocolVersion: in.ProtocolVersion, OwnerID: owner, DeviceID: device,
		OperationID: in.OperationID, OperationKind: in.OperationKind, ConflictID: id,
		DocumentID: in.DocumentID, BaseRevisionID: in.BaseRevisionID, Title: in.Title,
		Payload: in.Payload, PayloadSHA256: in.PayloadSHA256, ClientCursor: in.ClientCursor,
	})
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

var deviceRevokePathRE = regexp.MustCompile(`^` + regexp.QuoteMeta(PathPrefix) + `/devices/([a-z0-9][a-z0-9-]{0,62})/revoke$`)

func (h *Handler) revoke(w http.ResponseWriter, r *http.Request, owner, credentialDevice, path string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	matches := deviceRevokePathRE.FindStringSubmatch(path)
	if len(matches) != 2 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "sync resource not found")
		return
	}
	id := matches[1]
	// device. There is no body owner/admin override.
	if id == "" || strings.Contains(id, "/") || id != credentialDevice || !v2sync.ValidStableID(id) {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "owner/device authorization failed")
		return
	}
	if err := h.store.RevokeDevice(owner, id); err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"protocol_version": v2sync.ProtocolVersion, "device_id": id, "status": "revoked"})
}
func (h *Handler) pull(w http.ResponseWriter, r *http.Request, owner, device string) {
	for key, values := range r.URL.Query() {
		if (key != "after" && key != "limit") || len(values) != 1 {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "pull accepts only after and limit")
			return
		}
	}
	after, limit := int64(0), int64(1000)
	var err error
	if s := r.URL.Query().Get("after"); s != "" {
		after, err = strconv.ParseInt(s, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "after must be an integer")
			return
		}
	}
	if s := r.URL.Query().Get("limit"); s != "" {
		limit, err = strconv.ParseInt(s, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_QUERY", "limit must be an integer")
			return
		}
	}
	out, err := h.store.Pull(owner, device, after, int(limit))
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type ackRequest struct {
	Cursor int64 `json:"cursor"`
}

func (h *Handler) ack(w http.ResponseWriter, r *http.Request, owner, device string) {
	var in ackRequest
	if !requireJSONBody(w, r, &in, "cursor") {
		return
	}
	if err := h.store.Ack(owner, device, in.Cursor); err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"protocol_version": v2sync.ProtocolVersion, "cursor": in.Cursor, "status": "acknowledged"})
}

func (h *Handler) snapshot(w http.ResponseWriter, r *http.Request, owner, device string) {
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "INVALID_QUERY", "snapshot does not accept query parameters")
		return
	}
	out, err := h.store.Snapshot(owner, device)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) diagnostics(w http.ResponseWriter, owner, device string) {
	d, err := h.store.Diagnostics(owner, device)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func requireJSONBody(w http.ResponseWriter, r *http.Request, dst any, allowed ...string) bool {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if contentType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "application/json is required")
		return false
	}
	if r.ContentLength > MaxBodySize {
		writeError(w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body exceeds 8 MiB")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBodySize+1))
	if err != nil || len(body) > MaxBodySize {
		writeError(w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "request body exceeds 8 MiB")
		return false
	}
	if err := decodeStrictObject(body, dst, allowed); err != nil {
		code := "INVALID_JSON"
		if errors.Is(err, errUnknownField) {
			code = "UNKNOWN_FIELD"
		} else if errors.Is(err, errTrailingJSON) {
			code = "TRAILING_JSON"
		}
		writeError(w, http.StatusBadRequest, code, "request body is invalid JSON")
		return false
	}
	return true
}

var (
	errUnknownField = errors.New("unknown json field")
	errTrailingJSON = errors.New("trailing json")
)

func decodeStrictObject(body []byte, dst any, allowed []string) error {
	if len(body) == 0 {
		return errors.New("empty body")
	}
	var raw any
	if err := decodeJSONNoDuplicates(body, &raw); err != nil {
		return err
	}
	if _, ok := raw.(map[string]any); !ok {
		return errors.New("body must be a JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return errUnknownField
		}
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errTrailingJSON
	}
	// Keep the allow-list adjacent to the endpoint contract. DisallowUnknownFields
	// validates destination fields; this check also rejects fields hidden by a
	// future embedded struct/tag change.
	allowedSet := make(map[string]bool, len(allowed))
	for _, field := range allowed {
		allowedSet[field] = true
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		return errors.New("body must be a JSON object")
	}
	for field := range fields {
		if !allowedSet[field] {
			return errUnknownField
		}
	}
	return nil
}

func decodeJSONNoDuplicates(body []byte, dst *any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := parseJSONValue(decoder)
	if err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errTrailingJSON
	}
	*dst = value
	return nil
}

func parseJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		object := map[string]any{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("invalid object key")
			}
			if _, duplicate := object[key]; duplicate {
				return nil, errors.New("duplicate json field")
			}
			value, err := parseJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		var array []any
		for decoder.More() {
			value, err := parseJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return array, nil
	default:
		return nil, errors.New("invalid JSON delimiter")
	}
}

func setHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "X-ExeDev-UserID, X-Songs-V2-Device-ID, X-Songs-V2-Device-Token")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

type errorResponse struct {
	SchemaVersion string `json:"schema_version"`
	Error         struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	setHeaders(w)
	var out errorResponse
	out.SchemaVersion = "1"
	out.Error.Code = code
	out.Error.Message = message
	writeJSON(w, status, out)
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "method is not supported")
}

func writeMappedError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if _, ok := err.(*v2auth.AuthError); ok || errors.Is(err, v2sync.ErrUnauthorized) || errors.Is(err, v2sync.ErrRevoked) {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "owner/device authorization failed")
		return
	}
	status, code, message := http.StatusBadRequest, "INVALID_ENVELOPE", "request could not be accepted"
	switch {
	case errors.Is(err, v2sync.ErrRegistration):
		status, code, message = http.StatusConflict, "REGISTRATION_MISMATCH", "device registration does not match the durable registration"
	case errors.Is(err, v2sync.ErrReplayMismatch):
		status, code, message = http.StatusConflict, "OPERATION_REPLAY_MISMATCH", "operation ID was reused with different canonical bytes"
	case errors.Is(err, v2sync.ErrConflictCAS):
		status, code, message = http.StatusConflict, "CONFLICT_CAS_FAILED", "conflict compare-and-swap failed"
	case errors.Is(err, v2sync.ErrPublicationReserved):
		status, code, message = http.StatusConflict, "PUBLICATION_RESERVED", "document is reserved for publication"
	case errors.Is(err, v2sync.ErrUnknownBase):
		status, code, message = http.StatusConflict, "UNKNOWN_BASE", "base revision is unknown"
	case errors.Is(err, v2sync.ErrWrongDocument):
		status, code, message = http.StatusConflict, "WRONG_DOCUMENT", "base revision belongs to another document"
	case errors.Is(err, v2sync.ErrFutureCursor):
		status, code, message = http.StatusConflict, "FUTURE_CURSOR", "cursor is beyond the owner's event sequence"
	case errors.Is(err, v2sync.ErrResnapshotRequired):
		status, code, message = http.StatusConflict, "RESNAPSHOT_REQUIRED", "cursor requires a fresh snapshot"
	case errors.Is(err, v2sync.ErrNotFound):
		status, code, message = http.StatusUnauthorized, "UNAUTHENTICATED", "owner/device authorization failed"
	case errors.Is(err, v2sync.ErrPayloadHash):
		code, message = "PAYLOAD_HASH_MISMATCH", "supplied payload hash does not match canonical payload"
	case v2sync.IsCode(err, "INVALID_PAYLOAD"):
		code, message = "INVALID_PAYLOAD", "payload is invalid"
	case v2sync.IsCode(err, "INVALID_ENVELOPE"):
		code, message = "INVALID_ENVELOPE", "envelope is invalid"
	}
	writeError(w, status, code, message)
}
