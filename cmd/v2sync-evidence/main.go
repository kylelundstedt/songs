// v2sync-evidence runs the deterministic TASK-017 production-sync proof.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	"songs.exe.dev/internal/v2auth"
	"songs.exe.dev/internal/v2sync"
	"songs.exe.dev/internal/v2syncapi"
)

const (
	ownerID       = "owner-main"
	forwardedHost = "sync.invalid"
	deviceA       = "device-a"
	deviceB       = "device-b"
)

var masterKey = []byte("task-017-deterministic-master-key-material")

type errorBody struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

type response struct {
	Status int
	Body   []byte
	Header http.Header
}

type publicResponse struct {
	Status    int    `json:"status"`
	ErrorCode string `json:"error_code,omitempty"`
}

type registrationView struct {
	OwnerID        string `json:"owner_id"`
	DeviceID       string `json:"device_id"`
	RegistrationID string `json:"registration_id"`
	Name           string `json:"name"`
	Status         string `json:"status"`
}

type pulledRevision struct {
	RevisionID string          `json:"revision_id"`
	DocumentID string          `json:"document_id"`
	Title      string          `json:"title"`
	Payload    json.RawMessage `json:"payload"`
}

type evidence struct {
	SchemaVersion   string `json:"schema_version"`
	Task            string `json:"task"`
	ProtocolVersion string `json:"protocol_version"`
	Execution       struct {
		TemporaryDatabases bool `json:"temporary_databases"`
		InProcessHTTP      bool `json:"in_process_http_requests"`
		CanonicalJSON      bool `json:"canonical_json"`
	} `json:"execution"`
	Authorization struct {
		SpoofAttempts []struct {
			Case               string `json:"case"`
			Status             int    `json:"status"`
			ErrorCode          string `json:"error_code"`
			SamePublicResponse bool   `json:"same_public_response"`
		} `json:"spoof_attempts"`
		BodyOwnerOverride  publicResponse `json:"body_owner_override"`
		QueryOwnerOverride publicResponse `json:"query_owner_override"`
		RequestHostIgnored bool           `json:"request_host_ignored"`
	} `json:"authorization"`
	Registration struct {
		First                 registrationView `json:"first"`
		Retry                 registrationView `json:"retry"`
		ExactResponseReplay   bool             `json:"exact_response_replay"`
		Mismatch              publicResponse   `json:"mismatch"`
		DurableDeviceCount    int64            `json:"durable_device_count"`
		CredentialsNotEmitted bool             `json:"credentials_not_emitted"`
	} `json:"registration"`
	CredentialBoundary struct {
		Denials []struct {
			Case               string `json:"case"`
			Status             int    `json:"status"`
			ErrorCode          string `json:"error_code"`
			SamePublicResponse bool   `json:"same_public_response"`
		} `json:"denials"`
		BodyDeviceSpoof publicResponse `json:"body_device_spoof"`
		Diagnostics     struct {
			Status              int  `json:"status"`
			PrivateNoStore      bool `json:"private_no_store"`
			ContentFieldsAbsent bool `json:"content_fields_absent"`
			CredentialAbsent    bool `json:"credential_absent"`
		} `json:"diagnostics_nonleak"`
	} `json:"credential_boundary"`
	ApplyReplay struct {
		ResponseDiscardedAfterCommit bool           `json:"response_discarded_after_commit"`
		DurableBeforeRetry           bool           `json:"durable_before_retry"`
		RetryOutcome                 v2sync.Outcome `json:"retry_outcome"`
		RepeatedRetryExact           bool           `json:"repeated_retry_exact"`
		SingleOperation              bool           `json:"single_operation"`
		SingleEvent                  bool           `json:"single_event"`
		ReuseMismatch                publicResponse `json:"reuse_mismatch"`
	} `json:"apply_replay"`
	ConflictCAS struct {
		FirstConflict       v2sync.Outcome `json:"first_conflict"`
		AdvancedRevision    string         `json:"advanced_revision"`
		StaleResolution     publicResponse `json:"stale_resolution"`
		SecondConflict      v2sync.Outcome `json:"second_conflict"`
		Resolved            v2sync.Outcome `json:"resolved"`
		StaleConflictOpen   bool           `json:"stale_conflict_open"`
		ResolvedConflictCAS bool           `json:"resolved_conflict_cas"`
	} `json:"conflict_cas"`
	PullAcknowledgement struct {
		CursorBeforePull int64            `json:"cursor_before_pull"`
		PullCursor       int64            `json:"pull_cursor"`
		EventCount       int              `json:"event_count"`
		Revisions        []pulledRevision `json:"revisions_with_content"`
		CursorAfterPull  int64            `json:"cursor_after_pull"`
		Ack              publicResponse   `json:"explicit_ack"`
		CursorAfterAck   int64            `json:"cursor_after_ack"`
		CompactionFloor  int64            `json:"compaction_floor"`
		OldCursor        publicResponse   `json:"old_cursor"`
	} `json:"pull_acknowledgement"`
	Revocation struct {
		Revoke             publicResponse `json:"revoke"`
		RevokedDevice      publicResponse `json:"revoked_device"`
		ActiveDeviceStatus int            `json:"active_device_status"`
		ActiveDeviceCount  int64          `json:"active_device_count"`
	} `json:"revocation"`
	Restart struct {
		ExactSemanticSnapshot bool           `json:"exact_semantic_snapshot"`
		ActiveAuthPreserved   bool           `json:"active_authorization_preserved"`
		RevocationPreserved   bool           `json:"revocation_preserved"`
		ReplayPreserved       v2sync.Outcome `json:"operation_replay_preserved"`
		Acknowledgement       int64          `json:"acknowledgement_preserved"`
	} `json:"restart"`
	BackupRestore struct {
		OnlineBackup          bool `json:"online_backup"`
		ExactSemanticSnapshot bool `json:"exact_semantic_snapshot"`
		ActiveAuthExact       bool `json:"active_authorization_exact"`
		RevocationExact       bool `json:"revocation_exact"`
		SourceIntegrity       bool `json:"source_integrity"`
		RestoredIntegrity     bool `json:"restored_integrity"`
	} `json:"backup_restore"`
	FinalDiagnostics v2sync.Diagnostics `json:"final_diagnostics"`
	DeploymentGuard  struct {
		CheckedSource                string `json:"checked_source"`
		DisabledByDefault            bool   `json:"disabled_by_default"`
		ExplicitEnableBranch         bool   `json:"explicit_enable_branch"`
		ConfigurationRejectedIfOff   bool   `json:"configuration_rejected_if_off"`
		RequiredConfigurationWhenOn  bool   `json:"required_configuration_when_on"`
		RestrictedKeyFilePermissions bool   `json:"restricted_key_file_permissions"`
	} `json:"deployment_guard"`
	Acceptance struct {
		AllPassed bool `json:"all_passed"`
	} `json:"acceptance"`
}

type harness struct{ handler http.Handler }

func newHarness(store *v2sync.Store) (*harness, error) {
	h, err := v2syncapi.New(store, v2syncapi.Config{
		Store: store, OwnerID: ownerID, ForwardedHost: forwardedHost, MasterKey: masterKey,
	})
	if err != nil {
		return nil, err
	}
	return &harness{handler: h.Handler()}, nil
}

func (h *harness) request(method, path string, body []byte, device, credential string, mutate func(*http.Request)) response {
	r := httptest.NewRequest(method, "https://request.invalid"+path, bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set(v2auth.ForwardedProtoHeader, "https")
	r.Header.Set(v2auth.ForwardedHostHeader, forwardedHost)
	r.Header.Set(v2auth.UserHeader, ownerID)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if device != "" {
		r.Header.Set(v2auth.DeviceIDHeader, device)
	}
	if credential != "" {
		r.Header.Set(v2auth.DeviceTokenHeader, credential)
	}
	if mutate != nil {
		mutate(r)
	}
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return response{Status: w.Code, Body: append([]byte(nil), w.Body.Bytes()...), Header: w.Header().Clone()}
}

type discardWriter struct {
	header http.Header
	status int
	bytes  int
}

func (w *discardWriter) Header() http.Header { return w.header }
func (w *discardWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *discardWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.bytes += len(p)
	return len(p), nil
}

func (h *harness) discard(method, path string, body []byte, device, credential string) *discardWriter {
	r := httptest.NewRequest(method, "https://request.invalid"+path, bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set(v2auth.ForwardedProtoHeader, "https")
	r.Header.Set(v2auth.ForwardedHostHeader, forwardedHost)
	r.Header.Set(v2auth.UserHeader, ownerID)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(v2auth.DeviceIDHeader, device)
	r.Header.Set(v2auth.DeviceTokenHeader, credential)
	w := &discardWriter{header: make(http.Header)}
	h.handler.ServeHTTP(w, r)
	return w
}

func jsonBody(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

func public(r response) publicResponse {
	out := publicResponse{Status: r.Status}
	var body errorBody
	if json.Unmarshal(r.Body, &body) == nil {
		out.ErrorCode = body.Error.Code
	}
	return out
}

func require(ok bool, message string) error {
	if !ok {
		return errors.New(message)
	}
	return nil
}

func registration(r response) (registrationView, string, error) {
	var full struct {
		ProtocolVersion string `json:"protocol_version"`
		OwnerID         string `json:"owner_id"`
		DeviceID        string `json:"device_id"`
		RegistrationID  string `json:"registration_id"`
		Name            string `json:"name"`
		Status          string `json:"status"`
		Credential      string `json:"token"`
	}
	if r.Status != http.StatusOK {
		return registrationView{}, "", fmt.Errorf("registration status %d", r.Status)
	}
	if err := json.Unmarshal(r.Body, &full); err != nil {
		return registrationView{}, "", err
	}
	if full.ProtocolVersion != v2sync.ProtocolVersion || full.Credential == "" {
		return registrationView{}, "", errors.New("invalid registration response")
	}
	return registrationView{full.OwnerID, full.DeviceID, full.RegistrationID, full.Name, full.Status}, full.Credential, nil
}

func applyBody(device, operation, document, base, title string, payload any, cursor int64) ([]byte, error) {
	raw := jsonBody(payload)
	digest, canonical, err := v2sync.HashPayload(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
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
	}{v2sync.ProtocolVersion, device, operation, "put-document", document, base, title, canonical, digest, cursor})
}

func resolveBody(device, operation, document, base, title string, payload any, cursor int64) ([]byte, error) {
	raw := jsonBody(payload)
	digest, canonical, err := v2sync.HashPayload(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
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
	}{v2sync.ProtocolVersion, device, operation, "resolve-conflict", document, base, title, canonical, digest, cursor})
}

func outcome(r response) (v2sync.Outcome, error) {
	if r.Status != http.StatusOK {
		return v2sync.Outcome{}, fmt.Errorf("outcome status %d: %s", r.Status, r.Body)
	}
	var out v2sync.Outcome
	if err := json.Unmarshal(r.Body, &out); err != nil {
		return out, err
	}
	return out, nil
}

func run(root string) (e evidence, err error) {
	e.SchemaVersion = "1.0"
	e.Task = "TASK-017"
	e.ProtocolVersion = v2sync.ProtocolVersion
	e.Execution.TemporaryDatabases = true
	e.Execution.InProcessHTTP = true
	e.Execution.CanonicalJSON = true

	primaryPath := filepath.Join(root, "primary.sqlite")
	backupPath := filepath.Join(root, "restored.sqlite")
	store, err := v2sync.Open(primaryPath)
	if err != nil {
		return e, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = store.Close()
		}
	}()
	h, err := newHarness(store)
	if err != nil {
		return e, err
	}

	registerA := jsonBody(map[string]any{"protocol_version": "1", "device_id": deviceA, "registration_id": "registration-a", "name": "Primary tablet"})
	proxyCases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"missing-owner-assertion", func(r *http.Request) { r.Header.Del(v2auth.UserHeader) }},
		{"forged-owner-assertion", func(r *http.Request) { r.Header.Set(v2auth.UserHeader, "owner-other") }},
		{"forged-proxy-authority", func(r *http.Request) { r.Header.Set(v2auth.ForwardedHostHeader, "other.invalid") }},
		{"insecure-forwarded-protocol", func(r *http.Request) { r.Header.Set(v2auth.ForwardedProtoHeader, "http") }},
		{"forwarded-address-cannot-mask-remote", func(r *http.Request) { r.RemoteAddr = "192.0.2.9:9"; r.Header.Set("X-Forwarded-For", "127.0.0.1") }},
	}
	var denialBody []byte
	for _, tc := range proxyCases {
		r := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", registerA, "", "", tc.mutate)
		p := public(r)
		if err := require(p.Status == http.StatusUnauthorized && p.ErrorCode == "UNAUTHENTICATED", "proxy spoof was not denied"); err != nil {
			return e, err
		}
		if denialBody == nil {
			denialBody = r.Body
		}
		e.Authorization.SpoofAttempts = append(e.Authorization.SpoofAttempts, struct {
			Case               string `json:"case"`
			Status             int    `json:"status"`
			ErrorCode          string `json:"error_code"`
			SamePublicResponse bool   `json:"same_public_response"`
		}{tc.name, p.Status, p.ErrorCode, bytes.Equal(denialBody, r.Body)})
	}
	bodyOverride := jsonBody(map[string]any{"protocol_version": "1", "owner_id": "owner-other", "device_id": deviceA, "registration_id": "registration-a", "name": "Primary tablet"})
	r := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", bodyOverride, "", "", nil)
	e.Authorization.BodyOwnerOverride = public(r)
	if err := require(r.Status == http.StatusBadRequest && e.Authorization.BodyOwnerOverride.ErrorCode == "UNKNOWN_FIELD", "body owner override accepted"); err != nil {
		return e, err
	}

	first := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", registerA, "", "", nil)
	firstView, credentialA, err := registration(first)
	if err != nil {
		return e, err
	}
	retry := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", registerA, "", "", nil)
	retryView, retryCredential, err := registration(retry)
	if err != nil {
		return e, err
	}
	if err := require(credentialA == retryCredential && bytes.Equal(first.Body, retry.Body), "registration retry was not deterministic"); err != nil {
		return e, err
	}
	e.Registration.First = firstView
	e.Registration.Retry = retryView
	e.Registration.ExactResponseReplay = true
	e.Registration.CredentialsNotEmitted = true
	mismatchBody := jsonBody(map[string]any{"protocol_version": "1", "device_id": deviceA, "registration_id": "registration-a", "name": "Changed name"})
	e.Registration.Mismatch = public(h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", mismatchBody, "", "", nil))
	if err := require(e.Registration.Mismatch.Status == http.StatusConflict && e.Registration.Mismatch.ErrorCode == "REGISTRATION_MISMATCH", "registration mismatch not rejected"); err != nil {
		return e, err
	}
	registerB := jsonBody(map[string]any{"protocol_version": "1", "device_id": deviceB, "registration_id": "registration-b", "name": "Secondary tablet"})
	registeredB := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/register", registerB, "", "", nil)
	_, credentialB, err := registration(registeredB)
	if err != nil {
		return e, err
	}

	deviceDenials := []struct {
		name       string
		device     string
		credential string
		path       string
	}{
		{"missing-credential", "", "", v2syncapi.PathPrefix + "/health"},
		{"wrong-credential", deviceA, "incorrect", v2syncapi.PathPrefix + "/health"},
		{"unknown-device", "device-unknown", "incorrect", v2syncapi.PathPrefix + "/health"},
		{"query-credential-ignored", "", "", v2syncapi.PathPrefix + "/health?device_id=device-a&credential=incorrect"},
	}
	var deviceDenialBody []byte
	for _, tc := range deviceDenials {
		r := h.request(http.MethodGet, tc.path, nil, tc.device, tc.credential, nil)
		p := public(r)
		if err := require(p.Status == http.StatusUnauthorized && p.ErrorCode == "UNAUTHENTICATED", "device denial failed"); err != nil {
			return e, err
		}
		if deviceDenialBody == nil {
			deviceDenialBody = r.Body
		}
		e.CredentialBoundary.Denials = append(e.CredentialBoundary.Denials, struct {
			Case               string `json:"case"`
			Status             int    `json:"status"`
			ErrorCode          string `json:"error_code"`
			SamePublicResponse bool   `json:"same_public_response"`
		}{tc.name, p.Status, p.ErrorCode, bytes.Equal(deviceDenialBody, r.Body)})
	}
	deviceSpoofBody, err := applyBody(deviceB, "op-device-spoof", "set-alpha", "", "Spoof", map[string]any{"version": "spoof"}, 0)
	if err != nil {
		return e, err
	}
	e.CredentialBoundary.BodyDeviceSpoof = public(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", deviceSpoofBody, deviceA, credentialA, nil))
	if err := require(e.CredentialBoundary.BodyDeviceSpoof.Status == http.StatusBadRequest && e.CredentialBoundary.BodyDeviceSpoof.ErrorCode == "INVALID_ENVELOPE", "body device spoof accepted"); err != nil {
		return e, err
	}

	healthNormal := h.request(http.MethodGet, v2syncapi.PathPrefix+"/health", nil, deviceA, credentialA, nil)
	healthHostSpoof := h.request(http.MethodGet, v2syncapi.PathPrefix+"/health", nil, deviceA, credentialA, func(r *http.Request) { r.Host = "untrusted.invalid" })
	e.Authorization.RequestHostIgnored = healthNormal.Status == http.StatusOK && bytes.Equal(healthNormal.Body, healthHostSpoof.Body)
	queryOwner := h.request(http.MethodGet, v2syncapi.PathPrefix+"/diagnostics?owner_id=owner-other", nil, deviceA, credentialA, nil)
	e.Authorization.QueryOwnerOverride = public(queryOwner)
	if err := require(e.Authorization.RequestHostIgnored && queryOwner.Status == http.StatusBadRequest && e.Authorization.QueryOwnerOverride.ErrorCode == "INVALID_QUERY", "untrusted owner fields affected authorization"); err != nil {
		return e, err
	}
	diagnosticResponse := h.request(http.MethodGet, v2syncapi.PathPrefix+"/diagnostics", nil, deviceA, credentialA, nil)
	lowerDiagnostic := strings.ToLower(string(diagnosticResponse.Body))
	e.CredentialBoundary.Diagnostics.Status = diagnosticResponse.Status
	e.CredentialBoundary.Diagnostics.PrivateNoStore = diagnosticResponse.Header.Get("Cache-Control") == "private, no-store"
	e.CredentialBoundary.Diagnostics.ContentFieldsAbsent = !strings.Contains(lowerDiagnostic, "payload") && !strings.Contains(lowerDiagnostic, "title") && !strings.Contains(lowerDiagnostic, "revision_id")
	e.CredentialBoundary.Diagnostics.CredentialAbsent = !strings.Contains(diagnosticResponse.BodyString(), credentialA) && !strings.Contains(diagnosticResponse.BodyString(), credentialB)
	if err := require(e.CredentialBoundary.Diagnostics.Status == http.StatusOK && e.CredentialBoundary.Diagnostics.PrivateNoStore && e.CredentialBoundary.Diagnostics.ContentFieldsAbsent && e.CredentialBoundary.Diagnostics.CredentialAbsent, "diagnostics leaked protected data"); err != nil {
		return e, err
	}

	seedBody, err := applyBody(deviceA, "op-seed", "set-alpha", "", "First set", map[string]any{"version": "seed", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-a"}}}, 0)
	if err != nil {
		return e, err
	}
	injected := false
	store.SetHooks(v2sync.Hooks{AfterCommit: func() error {
		if !injected {
			injected = true
			return errors.New("injected response boundary failure")
		}
		return nil
	}})
	discarded := h.discard(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", seedBody, deviceA, credentialA)
	store.SetHooks(v2sync.Hooks{})
	diagAfterLoss, err := store.Diagnostics(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.ApplyReplay.ResponseDiscardedAfterCommit = injected && discarded.bytes > 0
	e.ApplyReplay.DurableBeforeRetry = diagAfterLoss.OperationCount == 1 && diagAfterLoss.EventCount == 1 && diagAfterLoss.RevisionCount == 1
	seedRetry := h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", seedBody, deviceA, credentialA, nil)
	seedOutcome, err := outcome(seedRetry)
	if err != nil {
		return e, err
	}
	seedRetryAgain := h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", seedBody, deviceA, credentialA, nil)
	e.ApplyReplay.RetryOutcome = seedOutcome
	e.ApplyReplay.RepeatedRetryExact = bytes.Equal(seedRetry.Body, seedRetryAgain.Body)
	diagAfterRetries, err := store.Diagnostics(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.ApplyReplay.SingleOperation = diagAfterRetries.OperationCount == 1
	e.ApplyReplay.SingleEvent = diagAfterRetries.EventCount == 1
	mismatchApply, err := applyBody(deviceA, "op-seed", "set-alpha", "", "First set", map[string]any{"version": "different"}, 0)
	if err != nil {
		return e, err
	}
	e.ApplyReplay.ReuseMismatch = public(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", mismatchApply, deviceA, credentialA, nil))
	if err := require(e.ApplyReplay.ResponseDiscardedAfterCommit && e.ApplyReplay.DurableBeforeRetry && e.ApplyReplay.RepeatedRetryExact && e.ApplyReplay.SingleOperation && e.ApplyReplay.SingleEvent && e.ApplyReplay.ReuseMismatch.Status == http.StatusConflict && e.ApplyReplay.ReuseMismatch.ErrorCode == "OPERATION_REPLAY_MISMATCH", "apply replay proof failed"); err != nil {
		return e, err
	}

	editBody, _ := applyBody(deviceB, "op-edit", "set-alpha", seedOutcome.RevisionID, "Second set", map[string]any{"version": "edit", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-b"}}}, 0)
	editOutcome, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", editBody, deviceB, credentialB, nil))
	if err != nil {
		return e, err
	}
	staleBody, _ := applyBody(deviceA, "op-stale-one", "set-alpha", seedOutcome.RevisionID, "Stale candidate", map[string]any{"version": "candidate-one", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-c"}}}, 0)
	firstConflict, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", staleBody, deviceA, credentialA, nil))
	if err != nil {
		return e, err
	}
	advanceBody, _ := applyBody(deviceB, "op-advance", "set-alpha", editOutcome.RevisionID, "Advanced set", map[string]any{"version": "advance", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-d"}}}, 0)
	advanceOutcome, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", advanceBody, deviceB, credentialB, nil))
	if err != nil {
		return e, err
	}
	staleResolveBody, _ := resolveBody(deviceA, "op-resolve-stale", "set-alpha", editOutcome.RevisionID, "Rejected resolution", map[string]any{"version": "rejected-resolution"}, 0)
	staleResolution := h.request(http.MethodPost, v2syncapi.PathPrefix+"/conflicts/"+firstConflict.ConflictID+"/resolve", staleResolveBody, deviceA, credentialA, nil)
	secondStaleBody, _ := applyBody(deviceA, "op-stale-two", "set-alpha", editOutcome.RevisionID, "Second candidate", map[string]any{"version": "candidate-two", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-e"}}}, 0)
	secondConflict, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", secondStaleBody, deviceA, credentialA, nil))
	if err != nil {
		return e, err
	}
	resolveBodyBytes, _ := resolveBody(deviceA, "op-resolve", "set-alpha", advanceOutcome.RevisionID, "Resolved set", map[string]any{"version": "resolved", "entries": []any{map[string]any{"entry_id": "entry-a", "song_id": "song-f"}}}, 0)
	resolved, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/conflicts/"+secondConflict.ConflictID+"/resolve", resolveBodyBytes, deviceA, credentialA, nil))
	if err != nil {
		return e, err
	}
	firstConflictState, err := store.Conflict(ownerID, deviceA, firstConflict.ConflictID)
	if err != nil {
		return e, err
	}
	secondConflictState, err := store.Conflict(ownerID, deviceA, secondConflict.ConflictID)
	if err != nil {
		return e, err
	}
	e.ConflictCAS.FirstConflict = firstConflict
	e.ConflictCAS.AdvancedRevision = advanceOutcome.RevisionID
	e.ConflictCAS.StaleResolution = public(staleResolution)
	e.ConflictCAS.SecondConflict = secondConflict
	e.ConflictCAS.Resolved = resolved
	e.ConflictCAS.StaleConflictOpen = firstConflictState.Status == "open" && firstConflictState.ResolutionRevisionID == ""
	e.ConflictCAS.ResolvedConflictCAS = secondConflictState.Status == "resolved" && secondConflictState.ResolutionRevisionID == resolved.RevisionID
	if err := require(firstConflict.Status == "conflict" && secondConflict.Status == "conflict" && e.ConflictCAS.StaleResolution.Status == http.StatusConflict && e.ConflictCAS.StaleResolution.ErrorCode == "CONFLICT_CAS_FAILED" && e.ConflictCAS.StaleConflictOpen && e.ConflictCAS.ResolvedConflictCAS, "conflict CAS proof failed"); err != nil {
		return e, err
	}

	cursorBefore, err := store.DeviceCursor(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	pullResponse := h.request(http.MethodGet, v2syncapi.PathPrefix+"/pull?after=0&limit=100", nil, deviceA, credentialA, nil)
	var pull v2sync.PullResult
	if pullResponse.Status != http.StatusOK || json.Unmarshal(pullResponse.Body, &pull) != nil {
		return e, errors.New("pull failed")
	}
	cursorAfterPull, err := store.DeviceCursor(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.PullAcknowledgement.CursorBeforePull = cursorBefore
	e.PullAcknowledgement.PullCursor = pull.Cursor
	e.PullAcknowledgement.EventCount = len(pull.Events)
	for _, revision := range pull.Revisions {
		e.PullAcknowledgement.Revisions = append(e.PullAcknowledgement.Revisions, pulledRevision{revision.ID, revision.DocumentID, revision.Title, append(json.RawMessage(nil), revision.Payload...)})
	}
	e.PullAcknowledgement.CursorAfterPull = cursorAfterPull
	ackResponse := h.request(http.MethodPost, v2syncapi.PathPrefix+"/ack", jsonBody(map[string]any{"cursor": pull.Cursor}), deviceA, credentialA, nil)
	e.PullAcknowledgement.Ack = public(ackResponse)
	cursorAfterAck, err := store.DeviceCursor(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.PullAcknowledgement.CursorAfterAck = cursorAfterAck
	if err := store.SetCompactionFloor(ownerID, 1); err != nil {
		return e, err
	}
	e.PullAcknowledgement.CompactionFloor = 1
	e.PullAcknowledgement.OldCursor = public(h.request(http.MethodGet, v2syncapi.PathPrefix+"/pull?after=0&limit=100", nil, deviceA, credentialA, nil))
	if err := require(cursorBefore == 0 && cursorAfterPull == 0 && len(pull.Events) == 6 && len(pull.Revisions) == 6 && pull.Cursor == 6 && ackResponse.Status == http.StatusOK && cursorAfterAck == pull.Cursor && e.PullAcknowledgement.OldCursor.Status == http.StatusConflict && e.PullAcknowledgement.OldCursor.ErrorCode == "RESNAPSHOT_REQUIRED", "pull and acknowledgement proof failed"); err != nil {
		return e, err
	}

	revokeResponse := h.request(http.MethodPost, v2syncapi.PathPrefix+"/devices/"+deviceB+"/revoke", jsonBody(map[string]any{}), deviceB, credentialB, nil)
	revokedResponse := h.request(http.MethodGet, v2syncapi.PathPrefix+"/health", nil, deviceB, credentialB, nil)
	activeResponse := h.request(http.MethodGet, v2syncapi.PathPrefix+"/health", nil, deviceA, credentialA, nil)
	finalDiagnostics, err := store.Diagnostics(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.Revocation.Revoke = public(revokeResponse)
	e.Revocation.RevokedDevice = public(revokedResponse)
	e.Revocation.ActiveDeviceStatus = activeResponse.Status
	e.Revocation.ActiveDeviceCount = finalDiagnostics.ActiveDeviceCount
	if err := require(revokeResponse.Status == http.StatusOK && revokedResponse.Status == http.StatusUnauthorized && public(revokedResponse).ErrorCode == "UNAUTHENTICATED" && activeResponse.Status == http.StatusOK && finalDiagnostics.ActiveDeviceCount == 1, "revocation proof failed"); err != nil {
		return e, err
	}

	semanticBeforeRestart, err := store.SemanticSnapshot(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	if err := store.Integrity(); err != nil {
		return e, err
	}
	if err := store.Close(); err != nil {
		return e, err
	}
	closed = true
	store, err = v2sync.Open(primaryPath)
	if err != nil {
		return e, err
	}
	closed = false
	h, err = newHarness(store)
	if err != nil {
		return e, err
	}
	semanticAfterRestart, err := store.SemanticSnapshot(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	restartReplay, err := outcome(h.request(http.MethodPost, v2syncapi.PathPrefix+"/operations/apply", seedBody, deviceA, credentialA, nil))
	if err != nil {
		return e, err
	}
	restartCursor, err := store.DeviceCursor(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.Restart.ExactSemanticSnapshot = bytes.Equal(semanticBeforeRestart, semanticAfterRestart)
	e.Restart.ActiveAuthPreserved = store.AuthenticateDevice(ownerID, deviceA, credentialA) == nil
	e.Restart.RevocationPreserved = errors.Is(store.AuthenticateDevice(ownerID, deviceB, credentialB), v2sync.ErrRevoked)
	e.Restart.ReplayPreserved = restartReplay
	e.Restart.Acknowledgement = restartCursor
	if err := require(e.Restart.ExactSemanticSnapshot && e.Restart.ActiveAuthPreserved && e.Restart.RevocationPreserved && restartReplay == seedOutcome && restartCursor == pull.Cursor, "restart proof failed"); err != nil {
		return e, err
	}

	if err := store.Backup(backupPath); err != nil {
		return e, err
	}
	e.BackupRestore.OnlineBackup = true
	e.BackupRestore.SourceIntegrity = store.Integrity() == nil
	restored, err := v2sync.Open(backupPath)
	if err != nil {
		return e, err
	}
	defer restored.Close()
	restoredSemantic, err := restored.SemanticSnapshot(ownerID, deviceA)
	if err != nil {
		return e, err
	}
	e.BackupRestore.ExactSemanticSnapshot = bytes.Equal(semanticAfterRestart, restoredSemantic)
	e.BackupRestore.ActiveAuthExact = restored.AuthenticateDevice(ownerID, deviceA, credentialA) == nil
	e.BackupRestore.RevocationExact = errors.Is(restored.AuthenticateDevice(ownerID, deviceB, credentialB), v2sync.ErrRevoked)
	e.BackupRestore.RestoredIntegrity = restored.Integrity() == nil
	if err := require(e.BackupRestore.SourceIntegrity && e.BackupRestore.RestoredIntegrity && e.BackupRestore.ExactSemanticSnapshot && e.BackupRestore.ActiveAuthExact && e.BackupRestore.RevocationExact, "backup and restore proof failed"); err != nil {
		return e, err
	}
	e.FinalDiagnostics = finalDiagnostics
	e.Registration.DurableDeviceCount = finalDiagnostics.DeviceCount

	source, err := os.ReadFile("cmd/v2api/main.go")
	if err != nil {
		return e, fmt.Errorf("inspect deployment source: %w", err)
	}
	text := string(source)
	e.DeploymentGuard.CheckedSource = "cmd/v2api/main.go"
	e.DeploymentGuard.DisabledByDefault = strings.Contains(text, `flag.Bool("sync-enabled", false`)
	e.DeploymentGuard.ExplicitEnableBranch = strings.Contains(text, `if *flagSyncEnabled {`) && strings.Contains(text, `api = routeV2API`)
	e.DeploymentGuard.ConfigurationRejectedIfOff = strings.Contains(text, `sync configuration was supplied without -sync-enabled`)
	e.DeploymentGuard.RequiredConfigurationWhenOn = strings.Contains(text, `sync requires -sync-db, -sync-owner, -sync-forwarded-host, and -sync-master-key-file`)
	e.DeploymentGuard.RestrictedKeyFilePermissions = strings.Contains(text, `info.Mode().Perm()&0o077 != 0`)
	if err := require(e.DeploymentGuard.DisabledByDefault && e.DeploymentGuard.ExplicitEnableBranch && e.DeploymentGuard.ConfigurationRejectedIfOff && e.DeploymentGuard.RequiredConfigurationWhenOn && e.DeploymentGuard.RestrictedKeyFilePermissions, "deployment guard source assertions failed"); err != nil {
		return e, err
	}

	e.Acceptance.AllPassed = true
	return e, nil
}

func (r response) BodyString() string { return string(r.Body) }

func main() {
	root, err := os.MkdirTemp("", "v2sync-evidence-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(root)
	result, err := run(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded = append(encoded, '\n')
	if _, err := os.Stdout.Write(encoded); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
