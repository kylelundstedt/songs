package v2syncapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"songs.exe.dev/internal/v2auth"
	"songs.exe.dev/internal/v2sync"
)

const (
	testOwner = "owner-1"
	testHost  = "v2.example.test:443"
)

var testMasterKey = []byte("0123456789abcdef0123456789abcdef")

type apiFixture struct {
	t       *testing.T
	store   *v2sync.Store
	handler *Handler
	owner   string
	host    string
	key     []byte
}

type registeredDevice struct {
	ID    string
	Token string
}

type errorEnvelope struct {
	SchemaVersion string `json:"schema_version"`
	Error         struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func newFixture(t *testing.T) *apiFixture {
	t.Helper()
	store, err := v2sync.Open(filepath.Join(t.TempDir(), "sync.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	key := append([]byte(nil), testMasterKey...)
	handler, err := New(store, Config{OwnerID: testOwner, ForwardedHost: testHost, MasterKey: key})
	if err != nil {
		t.Fatal(err)
	}
	return &apiFixture{t: t, store: store, handler: handler, owner: testOwner, host: testHost, key: key}
}

func (f *apiFixture) trustedRequest(method, target string, body io.Reader) *http.Request {
	f.t.Helper()
	r := httptest.NewRequest(method, target, body)
	r.RemoteAddr = "127.0.0.1:4242"
	r.Header.Set(v2auth.UserHeader, f.owner)
	r.Header.Set(v2auth.ForwardedHostHeader, f.host)
	r.Header.Set(v2auth.ForwardedProtoHeader, "https")
	return r
}

func (f *apiFixture) serve(r *http.Request) *httptest.ResponseRecorder {
	f.t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func (f *apiFixture) request(method, target string, body []byte, device *registeredDevice) *httptest.ResponseRecorder {
	f.t.Helper()
	r := f.trustedRequest(method, target, bytes.NewReader(body))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if device != nil {
		r.Header.Set(v2auth.DeviceIDHeader, device.ID)
		r.Header.Set(v2auth.DeviceTokenHeader, device.Token)
	}
	return f.serve(r)
}

func (f *apiFixture) register(id, registrationID, name string) registeredDevice {
	f.t.Helper()
	body := marshalJSON(f.t, map[string]any{
		"protocol_version": v2sync.ProtocolVersion,
		"device_id":        id,
		"registration_id":  registrationID,
		"name":             name,
	})
	w := f.request(http.MethodPost, PathPrefix+"/devices/register", body, nil)
	assertStatus(f.t, w, http.StatusOK)
	var out registrationResponse
	decodeResponse(f.t, w, &out)
	if out.OwnerID != f.owner || out.DeviceID != id || out.RegistrationID != registrationID || out.Name != name || out.Status != "active" || out.Token == "" {
		f.t.Fatalf("unexpected registration: %+v", out)
	}
	return registeredDevice{ID: id, Token: out.Token}
}

func marshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func decodeResponse(t *testing.T, w *httptest.ResponseRecorder, dst any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(w.Body.Bytes()))
	if err := dec.Decode(dst); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		t.Fatalf("response has trailing JSON: %q", w.Body.String())
	}
}

func assertStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
	}
	assertSecurityHeaders(t, w)
}

func assertError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) errorEnvelope {
	t.Helper()
	assertStatus(t, w, status)
	var out errorEnvelope
	decodeResponse(t, w, &out)
	if out.SchemaVersion != "1" || out.Error.Code != code || out.Error.Message == "" {
		t.Fatalf("unexpected error response: %+v", out)
	}
	return out
}

func assertSecurityHeaders(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if got := w.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type=%q", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control=%q", got)
	}
	if got := w.Header().Get("Vary"); got != "X-ExeDev-UserID, X-Songs-V2-Device-ID, X-Songs-V2-Device-Token" {
		t.Errorf("Vary=%q", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options=%q", got)
	}
}

func assertNoLeak(t *testing.T, w *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	text := w.Body.String()
	for key, values := range w.Header() {
		text += key + strings.Join(values, "")
	}
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Errorf("response leaked %q: headers=%v body=%q", secret, w.Header(), w.Body.String())
		}
	}
}

func payloadHash(t *testing.T, payload json.RawMessage) string {
	t.Helper()
	hash, _, err := v2sync.HashPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func baselineBody(t *testing.T, owner, device, operation string, revisions []v2sync.BaselineRevision, documents []v2sync.DocumentMapping, publications []v2sync.PublicationMapping) []byte {
	t.Helper()
	return marshalJSON(t, map[string]any{
		"protocol_version": v2sync.ProtocolVersion,
		"device_id":        device,
		"operation_id":     operation,
		"revisions":        revisions,
		"documents":        documents,
		"publications":     publications,
	})
}

func applyBody(t *testing.T, device, operation, kind, document, base, title string, payload json.RawMessage, cursor int64) []byte {
	t.Helper()
	return marshalJSON(t, map[string]any{
		"protocol_version": v2sync.ProtocolVersion,
		"device_id":        device,
		"operation_id":     operation,
		"operation_kind":   kind,
		"document_id":      document,
		"base_revision_id": base,
		"title":            title,
		"payload":          payload,
		"payload_sha256":   payloadHash(t, payload),
		"client_cursor":    cursor,
	})
}

func resolveBody(t *testing.T, device, operation, document, base, title string, payload json.RawMessage, cursor int64) []byte {
	t.Helper()
	return applyBody(t, device, operation, "resolve-conflict", document, base, title, payload, cursor)
}

func apply(t *testing.T, f *apiFixture, device registeredDevice, body []byte) v2sync.Outcome {
	t.Helper()
	w := f.request(http.MethodPost, PathPrefix+"/operations/apply", body, &device)
	assertStatus(t, w, http.StatusOK)
	var out v2sync.Outcome
	decodeResponse(t, w, &out)
	return out
}

func createConflict(t *testing.T, f *apiFixture, first, second registeredDevice) (v2sync.Outcome, v2sync.Outcome, v2sync.Outcome) {
	t.Helper()
	initial := apply(t, f, first, applyBody(t, first.ID, "operation-1", "replace", "document-1", "", "Initial", json.RawMessage(`{"body":"one"}`), 0))
	current := apply(t, f, first, applyBody(t, first.ID, "operation-2", "replace", "document-1", initial.RevisionID, "Current", json.RawMessage(`{"body":"two"}`), initial.Sequence))
	conflict := apply(t, f, second, applyBody(t, second.ID, "operation-3", "replace", "document-1", initial.RevisionID, "Candidate", json.RawMessage(`{"body":"stale"}`), current.Sequence))
	if initial.Status != "applied" || current.Status != "applied" || conflict.Status != "conflict" || conflict.ConflictID == "" {
		t.Fatalf("unexpected setup outcomes: initial=%+v current=%+v conflict=%+v", initial, current, conflict)
	}
	return initial, current, conflict
}

func TestNewValidatesAndCopiesConfiguration(t *testing.T) {
	store, err := v2sync.Open(filepath.Join(t.TempDir(), "sync.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	valid := Config{OwnerID: testOwner, ForwardedHost: testHost, MasterKey: append([]byte(nil), testMasterKey...)}
	h, err := New(store, valid)
	if err != nil || h == nil || h.Handler() != h {
		t.Fatalf("New=(%v,%v)", h, err)
	}
	valid.MasterKey[0] ^= 0xff
	if bytes.Equal(h.key, valid.MasterKey) || !bytes.Equal(h.key, testMasterKey) {
		t.Fatal("master key was not defensively copied")
	}

	cases := []struct {
		name  string
		store *v2sync.Store
		cfg   Config
	}{
		{"nil store", nil, Config{OwnerID: testOwner, ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"empty key", store, Config{OwnerID: testOwner, ForwardedHost: testHost}},
		{"short key", store, Config{OwnerID: testOwner, ForwardedHost: testHost, MasterKey: bytes.Repeat([]byte{'k'}, 31)}},
		{"empty owner", store, Config{ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"leading owner whitespace", store, Config{OwnerID: " owner", ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"trailing owner whitespace", store, Config{OwnerID: "owner ", ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"owner NUL", store, Config{OwnerID: "owner\x00", ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"owner newline", store, Config{OwnerID: "owner\n", ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"owner too long", store, Config{OwnerID: strings.Repeat("o", 256), ForwardedHost: testHost, MasterKey: testMasterKey}},
		{"empty forwarded host", store, Config{OwnerID: testOwner, MasterKey: testMasterKey}},
		{"malformed forwarded host", store, Config{OwnerID: testOwner, ForwardedHost: "bad,host", MasterKey: testMasterKey}},
		{"invalid utf8 owner", store, Config{OwnerID: string([]byte{0xff}), ForwardedHost: testHost, MasterKey: testMasterKey}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := New(tc.store, tc.cfg); err == nil || got != nil {
				t.Fatalf("New=(%v,%v), want nil,error", got, err)
			}
		})
	}
}

func TestTrustedProxyBoundaryResistsHeaderAndIdentitySpoofing(t *testing.T) {
	f := newFixture(t)
	good := f.trustedRequest(http.MethodPost, PathPrefix+"/devices/register?owner_id=owner-2&device_id=spoofed", bytes.NewReader(marshalJSON(t, map[string]any{
		"protocol_version": "1", "device_id": "device-good", "registration_id": "registration-good", "name": "Good",
	})))
	good.Header.Set("Content-Type", "application/json")
	goodResponse := f.serve(good)
	assertStatus(t, goodResponse, http.StatusOK)
	var registration registrationResponse
	decodeResponse(t, goodResponse, &registration)
	if registration.OwnerID != testOwner || registration.DeviceID != "device-good" {
		t.Fatalf("query identity spoof affected registration: %+v", registration)
	}

	cases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"missing user", func(r *http.Request) { r.Header.Del(v2auth.UserHeader) }},
		{"wrong user", func(r *http.Request) { r.Header.Set(v2auth.UserHeader, "owner-2") }},
		{"missing forwarded host", func(r *http.Request) { r.Header.Del(v2auth.ForwardedHostHeader) }},
		{"wrong forwarded host", func(r *http.Request) { r.Header.Set(v2auth.ForwardedHostHeader, "evil.example") }},
		{"forwarded host list", func(r *http.Request) { r.Header.Set(v2auth.ForwardedHostHeader, testHost+",evil.example") }},
		{"missing forwarded proto", func(r *http.Request) { r.Header.Del(v2auth.ForwardedProtoHeader) }},
		{"wrong forwarded proto", func(r *http.Request) { r.Header.Set(v2auth.ForwardedProtoHeader, "http") }},
		{"proto case change", func(r *http.Request) { r.Header.Set(v2auth.ForwardedProtoHeader, "HTTPS") }},
		{"non-loopback IPv4", func(r *http.Request) { r.RemoteAddr = "203.0.113.9:4242" }},
		{"non-loopback IPv6", func(r *http.Request) { r.RemoteAddr = "[2001:db8::1]:4242" }},
		{"missing remote", func(r *http.Request) { r.RemoteAddr = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := f.trustedRequest(http.MethodGet, PathPrefix+"/health?owner_id="+testOwner, nil)
			r.Host = testHost
			r.Header.Set("Forwarded", "for=127.0.0.1;host="+testHost+";proto=https")
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			tc.mutate(r)
			w := f.serve(r)
			assertError(t, w, http.StatusUnauthorized, "UNAUTHENTICATED")
			assertNoLeak(t, w, testOwner, "owner-2", testHost)
		})
	}
}

func TestRegistrationIsDeterministicAndRequiresExactRetry(t *testing.T) {
	f := newFixture(t)
	body := marshalJSON(t, map[string]any{
		"protocol_version": "1", "device_id": "device-1", "registration_id": "registration-1", "name": "Studio iPad",
	})
	first := f.request(http.MethodPost, PathPrefix+"/devices/register", body, nil)
	second := f.request(http.MethodPost, PathPrefix+"/devices/register", body, nil)
	assertStatus(t, first, http.StatusOK)
	assertStatus(t, second, http.StatusOK)
	if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Fatalf("exact retry changed response:\nfirst=%s\nsecond=%s", first.Body.String(), second.Body.String())
	}
	var registration registrationResponse
	decodeResponse(t, first, &registration)
	wantToken, err := v2auth.GenerateDeviceToken(testMasterKey, testOwner, "device-1", "registration-1")
	if err != nil {
		t.Fatal(err)
	}
	if registration.Token != wantToken {
		t.Fatalf("token=%q want=%q", registration.Token, wantToken)
	}
	if err := f.store.AuthenticateDevice(testOwner, "device-1", registration.Token); err != nil {
		t.Fatalf("plaintext returned credential did not authenticate: %v", err)
	}
	if err := f.store.AuthenticateDevice(testOwner, "device-1", v2auth.HashDeviceToken(registration.Token)); err == nil {
		t.Fatal("stored token hash was accepted as a bearer credential")
	}

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"changed registration", map[string]any{"protocol_version": "1", "device_id": "device-1", "registration_id": "registration-2", "name": "Studio iPad"}},
		{"changed name", map[string]any{"protocol_version": "1", "device_id": "device-1", "registration_id": "registration-1", "name": "Other name"}},
		{"registration reused by another device", map[string]any{"protocol_version": "1", "device_id": "device-2", "registration_id": "registration-1", "name": "Studio iPad"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := f.request(http.MethodPost, PathPrefix+"/devices/register", marshalJSON(t, tc.body), nil)
			assertError(t, w, http.StatusConflict, "REGISTRATION_MISMATCH")
			assertNoLeak(t, w, registration.Token, v2auth.HashDeviceToken(registration.Token), testOwner, "registration-1")
		})
	}
}

func TestHeadersAndAuthenticationFailuresDoNotLeak(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "Private Device Name")
	unknownToken := strings.Repeat("x", 64)
	requests := []*http.Request{
		f.trustedRequest(http.MethodGet, PathPrefix+"/health", nil),
		f.trustedRequest(http.MethodGet, PathPrefix+"/health", nil),
		f.trustedRequest(http.MethodGet, PathPrefix+"/health", nil),
		f.trustedRequest(http.MethodGet, PathPrefix+"/health", nil),
	}
	requests[0].Header.Set(v2auth.DeviceIDHeader, device.ID)
	requests[0].Header.Set(v2auth.DeviceTokenHeader, "wrong-secret")
	requests[1].Header.Set(v2auth.DeviceIDHeader, "missing-device")
	requests[1].Header.Set(v2auth.DeviceTokenHeader, unknownToken)
	requests[2].Header.Set(v2auth.DeviceIDHeader, device.ID)
	requests[2].Header.Set(v2auth.DeviceTokenHeader, v2auth.HashDeviceToken(device.Token))
	requests[3].Header.Set(v2auth.DeviceIDHeader, device.ID)
	requests[3].Header.Set(v2auth.DeviceTokenHeader, strings.Repeat("z", 4097))

	var commonBody []byte
	for i, r := range requests {
		w := f.serve(r)
		assertError(t, w, http.StatusUnauthorized, "UNAUTHENTICATED")
		if i == 0 {
			commonBody = append([]byte(nil), w.Body.Bytes()...)
		} else if !bytes.Equal(commonBody, w.Body.Bytes()) {
			t.Errorf("authentication oracle: first=%q response[%d]=%q", commonBody, i, w.Body.Bytes())
		}
		assertNoLeak(t, w, device.Token, "wrong-secret", unknownToken, v2auth.HashDeviceToken(device.Token), "Private Device Name", testOwner, device.ID)
	}
}

func TestPlaintextCredentialWrongRevokedAndCrossOwnerBehavior(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "Device One")
	good := f.request(http.MethodGet, PathPrefix+"/health", nil, &device)
	assertStatus(t, good, http.StatusOK)

	wrong := registeredDevice{ID: device.ID, Token: "not-the-token"}
	assertError(t, f.request(http.MethodGet, PathPrefix+"/health", nil, &wrong), http.StatusUnauthorized, "UNAUTHENTICATED")

	otherHandler, err := New(f.store, Config{OwnerID: "owner-2", ForwardedHost: testHost, MasterKey: testMasterKey})
	if err != nil {
		t.Fatal(err)
	}
	otherRequest := func(method, target string, body []byte, d *registeredDevice) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, bytes.NewReader(body))
		r.RemoteAddr = "[::1]:5252"
		r.Header.Set(v2auth.UserHeader, "owner-2")
		r.Header.Set(v2auth.ForwardedHostHeader, testHost)
		r.Header.Set(v2auth.ForwardedProtoHeader, "https")
		if body != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if d != nil {
			r.Header.Set(v2auth.DeviceIDHeader, d.ID)
			r.Header.Set(v2auth.DeviceTokenHeader, d.Token)
		}
		w := httptest.NewRecorder()
		otherHandler.ServeHTTP(w, r)
		return w
	}
	registration := otherRequest(http.MethodPost, PathPrefix+"/devices/register", marshalJSON(t, map[string]any{
		"protocol_version": "1", "device_id": "device-1", "registration_id": "registration-1", "name": "Other Owner Device",
	}), nil)
	assertStatus(t, registration, http.StatusOK)
	var otherRegistration registrationResponse
	decodeResponse(t, registration, &otherRegistration)
	other := registeredDevice{ID: otherRegistration.DeviceID, Token: otherRegistration.Token}
	if other.Token == device.Token {
		t.Fatal("cross-owner registrations generated the same credential")
	}
	assertError(t, f.request(http.MethodGet, PathPrefix+"/health", nil, &other), http.StatusUnauthorized, "UNAUTHENTICATED")
	assertError(t, otherRequest(http.MethodGet, PathPrefix+"/health", nil, &device), http.StatusUnauthorized, "UNAUTHENTICATED")

	assertStatus(t, f.request(http.MethodPost, PathPrefix+"/devices/device-1/revoke", nil, &device), http.StatusOK)
	revoked := f.request(http.MethodGet, PathPrefix+"/health", nil, &device)
	assertError(t, revoked, http.StatusUnauthorized, "UNAUTHENTICATED")
	assertNoLeak(t, revoked, device.Token, testOwner, device.ID, "revoked")
}

func TestStrictJSONContentTypeBodySizeAndSyntax(t *testing.T) {
	valid := `{"protocol_version":"1","device_id":"device-1","registration_id":"registration-1","name":"Device"}`

	for _, tc := range []struct {
		name        string
		contentType string
		wantStatus  int
		wantCode    string
	}{
		{"canonical", "application/json", http.StatusOK, ""},
		{"case insensitive with charset", "Application/JSON; Charset=UTF-8", http.StatusOK, ""},
		{"missing", "", http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE"},
		{"text JSON", "text/json", http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE"},
		{"JSON suffix", "application/problem+json", http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE"},
	} {
		t.Run("content type "+tc.name, func(t *testing.T) {
			f := newFixture(t)
			r := f.trustedRequest(http.MethodPost, PathPrefix+"/devices/register", strings.NewReader(valid))
			if tc.contentType != "" {
				r.Header.Set("Content-Type", tc.contentType)
			}
			w := f.serve(r)
			if tc.wantCode == "" {
				assertStatus(t, w, tc.wantStatus)
			} else {
				assertError(t, w, tc.wantStatus, tc.wantCode)
			}
		})
	}

	for _, tc := range []struct {
		name, body, code string
	}{
		{"empty", "", "INVALID_JSON"},
		{"malformed", `{"protocol_version":`, "INVALID_JSON"},
		{"null", `null`, "INVALID_JSON"},
		{"array", `[]`, "INVALID_JSON"},
		{"unknown", `{"protocol_version":"1","device_id":"device-1","registration_id":"registration-1","name":"Device","owner_id":"other"}`, "UNKNOWN_FIELD"},
		{"trailing object", valid + `{}`, "TRAILING_JSON"},
		{"trailing scalar", valid + ` true`, "TRAILING_JSON"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			w := f.request(http.MethodPost, PathPrefix+"/devices/register", []byte(tc.body), nil)
			assertError(t, w, http.StatusBadRequest, tc.code)
		})
	}

	t.Run("exact body limit is accepted by decoder", func(t *testing.T) {
		f := newFixture(t)
		prefix := `{"protocol_version":"1","device_id":"device-1","registration_id":"registration-1","name":"`
		suffix := `"}`
		body := []byte(prefix + strings.Repeat("n", MaxBodySize-len(prefix)-len(suffix)) + suffix)
		if len(body) != MaxBodySize {
			t.Fatalf("test body length=%d", len(body))
		}
		w := f.request(http.MethodPost, PathPrefix+"/devices/register", body, nil)
		assertError(t, w, http.StatusBadRequest, "INVALID_ENVELOPE")
	})

	for _, tc := range []struct {
		name          string
		contentLength int64
	}{
		{"declared", MaxBodySize + 1},
		{"streamed", -1},
	} {
		t.Run("oversized "+tc.name, func(t *testing.T) {
			f := newFixture(t)
			body := bytes.Repeat([]byte{' '}, MaxBodySize+1)
			r := f.trustedRequest(http.MethodPost, PathPrefix+"/devices/register", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.ContentLength = tc.contentLength
			w := f.serve(r)
			assertError(t, w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE")
		})
	}
}

func TestStrictJSONRejectsDuplicateTopLevelAndPayloadFields(t *testing.T) {
	t.Run("duplicate top-level registration field", func(t *testing.T) {
		f := newFixture(t)
		body := []byte(`{"protocol_version":"1","device_id":"device-1","registration_id":"registration-1","name":"First","name":"Second"}`)
		w := f.request(http.MethodPost, PathPrefix+"/devices/register", body, nil)
		assertError(t, w, http.StatusBadRequest, "INVALID_JSON")
	})

	t.Run("duplicate nested payload field", func(t *testing.T) {
		f := newFixture(t)
		device := f.register("device-1", "registration-1", "Device")
		payload := json.RawMessage(`{"body":"first","body":"second"}`)
		sum := sha256.Sum256(payload)
		body := marshalJSON(t, map[string]any{
			"protocol_version": "1", "device_id": device.ID, "operation_id": "operation-1", "operation_kind": "replace",
			"document_id": "document-1", "base_revision_id": "", "title": "Title", "payload": payload,
			"payload_sha256": hex.EncodeToString(sum[:]), "client_cursor": 0,
		})
		w := f.request(http.MethodPost, PathPrefix+"/operations/apply", body, &device)
		assertError(t, w, http.StatusBadRequest, "INVALID_JSON")
	})
}

func TestWrongMethodsQueriesAndPaths(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "Device")

	for _, tc := range []struct{ path, allow string }{
		{PathPrefix + "/devices/register", http.MethodPost},
		{PathPrefix + "/operations/apply", http.MethodPost},
		{PathPrefix + "/ack", http.MethodPost},
		{PathPrefix + "/pull", http.MethodGet},
		{PathPrefix + "/snapshot", http.MethodGet},
		{PathPrefix + "/diagnostics", http.MethodGet},
		{PathPrefix + "/health", http.MethodGet},
		{PathPrefix + "/devices/device-1/revoke", http.MethodPost},
		{PathPrefix + "/conflicts/conf-0123456789abcdef01234567/resolve", http.MethodPost},
	} {
		t.Run("method "+tc.path, func(t *testing.T) {
			var credential *registeredDevice
			if tc.path != PathPrefix+"/devices/register" {
				credential = &device
			}
			w := f.request(http.MethodPatch, tc.path, nil, credential)
			assertError(t, w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
			if got := w.Header().Get("Allow"); got != tc.allow {
				t.Errorf("Allow=%q want=%q", got, tc.allow)
			}
		})
	}

	for _, tc := range []struct{ path, code string }{
		{PathPrefix, "NOT_FOUND"},
		{PathPrefix + "/", "NOT_FOUND"},
		{"/api/v2/synchronization/pull", "NOT_FOUND"},
		{PathPrefix + "/unknown", "NOT_FOUND"},
		{PathPrefix + "/devices/device-1/revoke/extra", "NOT_FOUND"},
		{PathPrefix + "/conflicts/conf-0123456789abcdef01234567/resolve/extra", "NOT_FOUND"},
	} {
		t.Run("path "+tc.path, func(t *testing.T) {
			w := f.request(http.MethodGet, tc.path, nil, &device)
			assertError(t, w, http.StatusNotFound, tc.code)
		})
	}

	for _, tc := range []struct{ query, code string }{
		{"unknown=1", "INVALID_QUERY"},
		{"after=0&after=1", "INVALID_QUERY"},
		{"limit=1&limit=2", "INVALID_QUERY"},
		{"after=not-an-int", "INVALID_QUERY"},
		{"limit=not-an-int", "INVALID_QUERY"},
		{"after=-1", "INVALID_ENVELOPE"},
		{"limit=0", "INVALID_ENVELOPE"},
		{"limit=1001", "INVALID_ENVELOPE"},
	} {
		t.Run("pull query "+tc.query, func(t *testing.T) {
			w := f.request(http.MethodGet, PathPrefix+"/pull?"+tc.query, nil, &device)
			assertError(t, w, http.StatusBadRequest, tc.code)
		})
	}
	assertError(t, f.request(http.MethodGet, PathPrefix+"/health?verbose=true", nil, &device), http.StatusBadRequest, "INVALID_QUERY")
	assertError(t, f.request(http.MethodGet, PathPrefix+"/diagnostics?verbose=true", nil, &device), http.StatusBadRequest, "INVALID_QUERY")
	assertError(t, f.request(http.MethodGet, PathPrefix+"/snapshot?after=0", nil, &device), http.StatusBadRequest, "INVALID_QUERY")
}

func TestApplyReportsPublicationReservation(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "Device")
	initialBody := applyBody(t, device.ID, "operation-1", "replace", "document-1", "", "Initial", json.RawMessage(`{"body":"one"}`), 0)
	initial := apply(t, f, device, initialBody)
	if err := f.store.ReservePublication(f.owner, device.ID, "document-1", initial.RevisionID, "pub-test-claim"); err != nil {
		t.Fatal(err)
	}
	replay := f.request(http.MethodPost, PathPrefix+"/operations/apply", initialBody, &device)
	assertStatus(t, replay, http.StatusOK)
	var replayed v2sync.Outcome
	decodeResponse(t, replay, &replayed)
	if replayed != initial {
		t.Fatalf("reserved HTTP replay = %+v, want %+v", replayed, initial)
	}
	changedReplay := applyBody(t, device.ID, "operation-1", "replace", "document-1", "", "Changed", json.RawMessage(`{"body":"one"}`), 0)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", changedReplay, &device), http.StatusConflict, "OPERATION_REPLAY_MISMATCH")
	body := applyBody(t, device.ID, "operation-2", "replace", "document-1", initial.RevisionID, "Edited", json.RawMessage(`{"body":"two"}`), initial.Sequence)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", body, &device), http.StatusConflict, "PUBLICATION_RESERVED")
}

func TestApplyReplayMismatchHashUnknownBaseWrongDocumentAndStaleConflict(t *testing.T) {
	f := newFixture(t)
	first := f.register("device-1", "registration-1", "First")
	second := f.register("device-2", "registration-2", "Second")

	initialBody := applyBody(t, first.ID, "operation-1", "replace", "document-1", "", "Initial", json.RawMessage(`{ "body": "one", "rank": 1 }`), 0)
	initialResponse := f.request(http.MethodPost, PathPrefix+"/operations/apply", initialBody, &first)
	assertStatus(t, initialResponse, http.StatusOK)
	var initial v2sync.Outcome
	decodeResponse(t, initialResponse, &initial)
	if initial.Status != "applied" || initial.Sequence != 1 || initial.RevisionID == "" || initial.ConflictID != "" {
		t.Fatalf("initial=%+v", initial)
	}

	for i := 0; i < 3; i++ {
		retry := f.request(http.MethodPost, PathPrefix+"/operations/apply", initialBody, &first)
		assertStatus(t, retry, http.StatusOK)
		if !bytes.Equal(initialResponse.Body.Bytes(), retry.Body.Bytes()) {
			t.Fatalf("retry %d changed response: first=%q retry=%q", i, initialResponse.Body.Bytes(), retry.Body.Bytes())
		}
	}

	mismatchBody := applyBody(t, first.ID, "operation-1", "replace", "document-1", "", "Changed", json.RawMessage(`{"body":"different"}`), 0)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", mismatchBody, &first), http.StatusConflict, "OPERATION_REPLAY_MISMATCH")

	badHashBody := applyBody(t, first.ID, "operation-hash", "replace", "document-hash", "", "Hash", json.RawMessage(`{"body":"hash"}`), 0)
	var badHash map[string]any
	if err := json.Unmarshal(badHashBody, &badHash); err != nil {
		t.Fatal(err)
	}
	badHash["payload_sha256"] = strings.Repeat("0", 64)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", marshalJSON(t, badHash), &first), http.StatusBadRequest, "PAYLOAD_HASH_MISMATCH")

	bodyDeviceMismatch := applyBody(t, second.ID, "operation-device", "replace", "document-device", "", "Device", json.RawMessage(`{}`), 0)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", bodyDeviceMismatch, &first), http.StatusBadRequest, "INVALID_ENVELOPE")

	unknown := applyBody(t, first.ID, "operation-unknown", "replace", "document-1", "rev-0123456789abcdef01234567", "Unknown", json.RawMessage(`{}`), 1)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", unknown, &first), http.StatusConflict, "UNKNOWN_BASE")

	secondDocument := apply(t, f, first, applyBody(t, first.ID, "operation-doc2", "replace", "document-2", "", "Other document", json.RawMessage(`{"body":"doc2"}`), 1))
	wrongDocument := applyBody(t, first.ID, "operation-wrong-document", "replace", "document-2", initial.RevisionID, "Wrong", json.RawMessage(`{}`), secondDocument.Sequence)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", wrongDocument, &first), http.StatusConflict, "WRONG_DOCUMENT")

	future := applyBody(t, first.ID, "operation-future", "replace", "document-3", "", "Future", json.RawMessage(`{}`), 999)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", future, &first), http.StatusConflict, "FUTURE_CURSOR")

	current := apply(t, f, first, applyBody(t, first.ID, "operation-2", "replace", "document-1", initial.RevisionID, "Current", json.RawMessage(`{"body":"two"}`), secondDocument.Sequence))
	stalePayload := json.RawMessage(`{ "body" : "candidate", "nested": {"b":2,"a":1} }`)
	stale := apply(t, f, second, applyBody(t, second.ID, "operation-3", "replace", "document-1", initial.RevisionID, "Candidate", stalePayload, current.Sequence))
	if stale.Status != "conflict" || stale.Sequence != current.Sequence+1 || stale.ConflictID == "" || stale.RevisionID == current.RevisionID {
		t.Fatalf("stale outcome=%+v current=%+v", stale, current)
	}

	diagnostics := f.request(http.MethodGet, PathPrefix+"/diagnostics", nil, &first)
	assertStatus(t, diagnostics, http.StatusOK)
	var d v2sync.Diagnostics
	decodeResponse(t, diagnostics, &d)
	if d.OperationCount != 4 || d.EventCount != 4 || d.RevisionCount != 4 || d.DocumentCount != 2 || d.OpenConflictCount != 1 || d.CurrentSequence != 4 {
		t.Fatalf("diagnostics after retries/rejections=%+v", d)
	}
}

func TestResolveConflictUsesCompareAndSwapAndIsIdempotent(t *testing.T) {
	f := newFixture(t)
	first := f.register("device-1", "registration-1", "First")
	second := f.register("device-2", "registration-2", "Second")
	_, current, conflict := createConflict(t, f, first, second)

	for _, tc := range []struct {
		name, conflictID, documentID, base string
	}{
		{"unknown conflict", "conf-0123456789abcdef01234567", "document-1", current.RevisionID},
		{"wrong document", conflict.ConflictID, "document-2", current.RevisionID},
		{"wrong current revision", conflict.ConflictID, "document-1", conflict.RevisionID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := resolveBody(t, second.ID, "resolve-rejected-"+strings.ReplaceAll(tc.name, " ", "-"), tc.documentID, tc.base, "Resolved", json.RawMessage(`{"body":"resolved"}`), conflict.Sequence)
			w := f.request(http.MethodPost, PathPrefix+"/conflicts/"+tc.conflictID+"/resolve", body, &second)
			assertError(t, w, http.StatusConflict, "CONFLICT_CAS_FAILED")
		})
	}

	body := resolveBody(t, second.ID, "resolve-1", "document-1", current.RevisionID, "Resolved", json.RawMessage(`{"body":"resolved","choice":"merged"}`), conflict.Sequence)
	firstResponse := f.request(http.MethodPost, PathPrefix+"/conflicts/"+conflict.ConflictID+"/resolve", body, &second)
	assertStatus(t, firstResponse, http.StatusOK)
	var resolved v2sync.Outcome
	decodeResponse(t, firstResponse, &resolved)
	if resolved.Status != "resolved" || resolved.ConflictID != conflict.ConflictID || resolved.Sequence != conflict.Sequence+1 || resolved.RevisionID == "" {
		t.Fatalf("resolved=%+v", resolved)
	}

	replay := f.request(http.MethodPost, PathPrefix+"/conflicts/"+conflict.ConflictID+"/resolve", body, &second)
	assertStatus(t, replay, http.StatusOK)
	if !bytes.Equal(firstResponse.Body.Bytes(), replay.Body.Bytes()) {
		t.Fatalf("resolution replay changed: first=%q replay=%q", firstResponse.Body.Bytes(), replay.Body.Bytes())
	}

	mismatch := resolveBody(t, second.ID, "resolve-1", "document-1", current.RevisionID, "Different", json.RawMessage(`{"body":"different"}`), conflict.Sequence)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/conflicts/"+conflict.ConflictID+"/resolve", mismatch, &second), http.StatusConflict, "OPERATION_REPLAY_MISMATCH")

	secondResolution := resolveBody(t, first.ID, "resolve-2", "document-1", current.RevisionID, "Again", json.RawMessage(`{}`), resolved.Sequence)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/conflicts/"+conflict.ConflictID+"/resolve", secondResolution, &first), http.StatusConflict, "CONFLICT_CAS_FAILED")
}

func TestPullReturnsCanonicalContentRevisionsAndConflicts(t *testing.T) {
	f := newFixture(t)
	first := f.register("device-1", "registration-1", "First")
	second := f.register("device-2", "registration-2", "Second")
	initial, current, conflictOutcome := createConflict(t, f, first, second)

	w := f.request(http.MethodGet, PathPrefix+"/pull?after=0&limit=1000", nil, &second)
	assertStatus(t, w, http.StatusOK)
	var pull v2sync.PullResult
	decodeResponse(t, w, &pull)
	if pull.Cursor != conflictOutcome.Sequence || pull.Floor != 0 || len(pull.Events) != 3 || len(pull.Revisions) != 3 || len(pull.Conflicts) != 1 {
		t.Fatalf("pull summary=%+v", pull)
	}
	for i, sequence := range []int64{initial.Sequence, current.Sequence, conflictOutcome.Sequence} {
		if pull.Events[i].Sequence != sequence || pull.Events[i].RevisionID != pull.Revisions[i].ID {
			t.Errorf("event/revision[%d]=%+v / %+v", i, pull.Events[i], pull.Revisions[i])
		}
	}
	candidate := pull.Revisions[2]
	if candidate.ID != conflictOutcome.RevisionID || candidate.DocumentID != "document-1" || candidate.DeviceID != second.ID || candidate.OperationID != "operation-3" || candidate.BaseRevisionID != initial.RevisionID || candidate.Title != "Candidate" || string(candidate.Payload) != `{"body":"stale"}` || candidate.ContentHash != payloadHash(t, candidate.Payload) {
		t.Errorf("candidate revision=%+v payload=%s", candidate, candidate.Payload)
	}
	conflict := pull.Conflicts[0]
	if conflict.ID != conflictOutcome.ConflictID || conflict.DocumentID != "document-1" || conflict.CurrentRevisionID != current.RevisionID || conflict.CandidateRevisionID != conflictOutcome.RevisionID || conflict.Status != "open" || conflict.ResolutionRevisionID != "" {
		t.Errorf("conflict=%+v", conflict)
	}

	page := f.request(http.MethodGet, PathPrefix+"/pull?after=1&limit=1", nil, &first)
	assertStatus(t, page, http.StatusOK)
	var one v2sync.PullResult
	decodeResponse(t, page, &one)
	if one.Cursor != 2 || len(one.Events) != 1 || one.Events[0].Sequence != 2 || len(one.Revisions) != 1 || len(one.Conflicts) != 0 {
		t.Fatalf("paged pull=%+v", one)
	}

	empty := f.request(http.MethodGet, PathPrefix+"/pull?after=3", nil, &first)
	assertStatus(t, empty, http.StatusOK)
	var none v2sync.PullResult
	decodeResponse(t, empty, &none)
	if none.Cursor != 3 || len(none.Events) != 0 || len(none.Revisions) != 0 || len(none.Conflicts) != 0 {
		t.Fatalf("empty pull=%+v", none)
	}
	for _, field := range []string{`"events":[]`, `"revisions":[]`, `"conflicts":[]`} {
		if !bytes.Contains(empty.Body.Bytes(), []byte(field)) {
			t.Fatalf("empty pull encoded %s as null: %s", field, empty.Body.String())
		}
	}

	assertError(t, f.request(http.MethodGet, PathPrefix+"/pull?after=4", nil, &first), http.StatusConflict, "FUTURE_CURSOR")
	if err := f.store.SetCompactionFloor(testOwner, 2); err != nil {
		t.Fatal(err)
	}
	assertError(t, f.request(http.MethodGet, PathPrefix+"/pull?after=1", nil, &first), http.StatusConflict, "RESNAPSHOT_REQUIRED")
}

func TestSnapshotUsesArraysForEmptyCollections(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "First")
	w := f.request(http.MethodGet, PathPrefix+"/snapshot", nil, &device)
	assertStatus(t, w, http.StatusOK)
	for _, field := range []string{`"documents":[]`, `"revisions":[]`, `"conflicts":[]`, `"publications":[]`} {
		if !bytes.Contains(w.Body.Bytes(), []byte(field)) {
			t.Fatalf("snapshot encoded %s as null: %s", field, w.Body.String())
		}
	}
}

func TestSnapshotReturnsAllRevisionsAndConflictsAtCurrentCursor(t *testing.T) {
	f := newFixture(t)
	first := f.register("device-1", "registration-1", "First")
	second := f.register("device-2", "registration-2", "Second")
	_, _, conflictOutcome := createConflict(t, f, first, second)
	if err := f.store.SetCompactionFloor(testOwner, 2); err != nil {
		t.Fatal(err)
	}

	w := f.request(http.MethodGet, PathPrefix+"/snapshot", nil, &first)
	assertStatus(t, w, http.StatusOK)
	var snapshot v2sync.SyncSnapshot
	decodeResponse(t, w, &snapshot)
	if snapshot.ProtocolVersion != v2sync.ProtocolVersion || snapshot.Cursor != conflictOutcome.Sequence || snapshot.Floor != 2 || len(snapshot.Revisions) != 3 || len(snapshot.Conflicts) != 1 {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if snapshot.Conflicts[0].ID != conflictOutcome.ConflictID || snapshot.Conflicts[0].Status != "open" {
		t.Fatalf("snapshot conflict=%+v", snapshot.Conflicts[0])
	}
	foundCandidate := false
	for _, revision := range snapshot.Revisions {
		if revision.ID == conflictOutcome.RevisionID {
			foundCandidate = string(revision.Payload) == `{"body":"stale"}` && revision.ContentHash == payloadHash(t, revision.Payload)
		}
	}
	if !foundCandidate {
		t.Fatalf("snapshot omitted canonical conflict candidate: %+v", snapshot.Revisions)
	}
}

func TestAckDiagnosticsAndHealth(t *testing.T) {
	f := newFixture(t)
	device := f.register("device-1", "registration-1", "Sensitive Device Name")
	outcome := apply(t, f, device, applyBody(t, device.ID, "operation-1", "replace", "document-1", "", "Sensitive Song Title", json.RawMessage(`{"secret":"private lyric"}`), 0))

	health := f.request(http.MethodGet, PathPrefix+"/health", nil, &device)
	assertStatus(t, health, http.StatusOK)
	var healthBody map[string]any
	decodeResponse(t, health, &healthBody)
	if len(healthBody) != 2 || healthBody["protocol_version"] != "1" || healthBody["status"] != "ok" {
		t.Fatalf("health=%v", healthBody)
	}
	assertNoLeak(t, health, device.Token, "Sensitive Device Name", "Sensitive Song Title", "private lyric", testOwner)

	ack := f.request(http.MethodPost, PathPrefix+"/ack", marshalJSON(t, map[string]any{"cursor": outcome.Sequence}), &device)
	assertStatus(t, ack, http.StatusOK)
	var ackBody map[string]any
	decodeResponse(t, ack, &ackBody)
	if ackBody["protocol_version"] != "1" || ackBody["status"] != "acknowledged" || ackBody["cursor"] != float64(outcome.Sequence) {
		t.Fatalf("ack=%v", ackBody)
	}
	assertError(t, f.request(http.MethodPost, PathPrefix+"/ack", marshalJSON(t, map[string]any{"cursor": outcome.Sequence + 1}), &device), http.StatusConflict, "FUTURE_CURSOR")
	assertError(t, f.request(http.MethodPost, PathPrefix+"/ack", marshalJSON(t, map[string]any{"cursor": -1}), &device), http.StatusBadRequest, "INVALID_ENVELOPE")

	// Acknowledgements are monotonic even when a client retries an older cursor.
	assertStatus(t, f.request(http.MethodPost, PathPrefix+"/ack", marshalJSON(t, map[string]any{"cursor": 0}), &device), http.StatusOK)
	diagnostics := f.request(http.MethodGet, PathPrefix+"/diagnostics", nil, &device)
	assertStatus(t, diagnostics, http.StatusOK)
	var d v2sync.Diagnostics
	decodeResponse(t, diagnostics, &d)
	if d.SchemaVersion != v2sync.SchemaVersion || d.DeviceCount != 1 || d.ActiveDeviceCount != 1 || d.DocumentCount != 1 || d.RevisionCount != 1 || d.OperationCount != 1 || d.EventCount != 1 || d.OpenConflictCount != 0 || d.AcknowledgedCursor != outcome.Sequence || d.CompactionFloor != 0 || d.CurrentSequence != outcome.Sequence {
		t.Fatalf("diagnostics=%+v", d)
	}
	assertNoLeak(t, diagnostics, device.Token, "Sensitive Device Name", "Sensitive Song Title", "private lyric", testOwner, "document-1", outcome.RevisionID, "operation-1")
}

func TestSelfRevokeOnlyAndImmediateCredentialInvalidation(t *testing.T) {
	f := newFixture(t)
	first := f.register("device-1", "registration-1", "First")
	second := f.register("device-2", "registration-2", "Second")

	other := f.request(http.MethodPost, PathPrefix+"/devices/device-2/revoke", nil, &first)
	assertError(t, other, http.StatusUnauthorized, "UNAUTHENTICATED")
	assertNoLeak(t, other, first.Token, second.Token, first.ID, second.ID, testOwner)
	assertStatus(t, f.request(http.MethodGet, PathPrefix+"/health", nil, &second), http.StatusOK)

	w := f.request(http.MethodPost, PathPrefix+"/devices/device-1/revoke", nil, &first)
	assertStatus(t, w, http.StatusOK)
	var response map[string]any
	decodeResponse(t, w, &response)
	if response["protocol_version"] != "1" || response["device_id"] != first.ID || response["status"] != "revoked" {
		t.Fatalf("revoke=%v", response)
	}
	assertNoLeak(t, w, first.Token, second.Token, testOwner)

	for _, path := range []string{PathPrefix + "/health", PathPrefix + "/diagnostics", PathPrefix + "/pull", PathPrefix + "/devices/device-1/revoke"} {
		w := f.request(http.MethodGet, path, nil, &first)
		assertError(t, w, http.StatusUnauthorized, "UNAUTHENTICATED")
		assertNoLeak(t, w, first.Token, "revoked", testOwner)
	}
	assertStatus(t, f.request(http.MethodGet, PathPrefix+"/health", nil, &second), http.StatusOK)

	retryRegistration := f.request(http.MethodPost, PathPrefix+"/devices/register", marshalJSON(t, map[string]any{
		"protocol_version": "1", "device_id": first.ID, "registration_id": "registration-1", "name": "First",
	}), nil)
	assertError(t, retryRegistration, http.StatusUnauthorized, "UNAUTHENTICATED")
	assertNoLeak(t, retryRegistration, first.Token, "revoked", testOwner)
}

func TestDigitLeadingStableIDsThroughHTTP(t *testing.T) {
	f := newFixture(t)
	device := f.register("1device", "2registration", "Imported device")
	body := applyBody(t, device.ID, "3operation", "replace", "2021-02-20-murphys", "", "Murphy's", json.RawMessage(`{}`), 0)
	outcome := apply(t, f, device, body)
	if outcome.Status != "applied" {
		t.Fatalf("digit-leading HTTP apply = %+v", outcome)
	}
	assertStatus(t, f.request(http.MethodPost, PathPrefix+"/devices/1device/revoke", nil, &device), http.StatusOK)
}
func TestDocumentWriteGatesRejectDisabledKinds(t *testing.T) {
	f := newFixture(t)
	handler, err := New(f.store, Config{OwnerID: f.owner, ForwardedHost: f.host, MasterKey: f.key, EnforceDocumentGates: true, SetListWritesEnabled: true, LeadSheetWritesEnabled: false})
	if err != nil {
		t.Fatal(err)
	}
	f.handler = handler
	device := f.register("device-gates", "registration-gates", "Gated device")
	lead := json.RawMessage(`{"schema_version":"v2publish-1","kind":"lead-sheet","path":"songs/Gated.md","source":"---\\nartist: Band\\n---\\n\\n# Gated\\n","deleted":false}`)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", applyBody(t, device.ID, "operation-lead-gated", "create-lead-sheet", "song-gated", "", "Gated", lead, 0), &device), http.StatusForbidden, "WRITE_DISABLED")
	leadBase, err := f.store.Apply(v2sync.ApplyEnvelope{
		ProtocolVersion: v2sync.ProtocolVersion, OwnerID: f.owner, DeviceID: device.ID,
		OperationID: "operation-lead-seed", OperationKind: "create-lead-sheet", DocumentID: "song-kind-gated",
		Title: "Lead seed", Payload: lead, PayloadSHA256: payloadHash(t, lead), ClientCursor: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	set := json.RawMessage(`{"schema_version":"v2publish-1","kind":"set-list","path":"sets/Gated.md","source":"set","deleted":false}`)
	assertError(t, f.request(http.MethodPost, PathPrefix+"/operations/apply", applyBody(t, device.ID, "operation-kind-change", "update-set-list", "song-kind-gated", leadBase.RevisionID, "Wrong kind", set, leadBase.Sequence), &device), http.StatusBadRequest, "INVALID_ENVELOPE")
	initial := apply(t, f, device, applyBody(t, device.ID, "operation-set-allowed", "create-set-list", "set-gated", "", "Gated", set, 0))
	head := apply(t, f, device, applyBody(t, device.ID, "operation-set-head", "update-set-list", "set-gated", initial.RevisionID, "Gated head", set, initial.Sequence))
	conflict := apply(t, f, device, applyBody(t, device.ID, "operation-set-stale", "update-set-list", "set-gated", initial.RevisionID, "Gated stale", set, head.Sequence))
	assertError(t, f.request(http.MethodPost, PathPrefix+"/conflicts/"+conflict.ConflictID+"/resolve", resolveBody(t, device.ID, "operation-kind-bypass", "set-gated", head.RevisionID, "Wrong kind", lead, conflict.Sequence), &device), http.StatusBadRequest, "INVALID_ENVELOPE")
}
