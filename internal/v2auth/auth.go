// Package v2auth contains the small, deliberately strict authentication boundary
// used by the writable V2 API. It trusts identity only after validating that the
// request came from the local proxy.
package v2auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
)

const (
	UserHeader           = "X-ExeDev-UserID"
	EmailHeader          = "X-ExeDev-Email"
	ForwardedHostHeader  = "X-Forwarded-Host"
	ForwardedProtoHeader = "X-Forwarded-Proto"
	DeviceIDHeader       = "X-Songs-V2-Device-ID"
	DeviceTokenHeader    = "X-Songs-V2-Device-Token"
)

var (
	ErrUnauthenticated  = errors.New("unauthenticated")
	ErrMalformed        = errors.New("malformed authentication request")
	ErrUnauthorized     = errors.New("unauthorized")
	ErrInvalidDeviceID  = errors.New("invalid device ID")
	ErrInvalidMasterKey = errors.New("invalid device master key")
	stableIDRE          = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
)

// AuthError is safe to map to an HTTP response. Its message intentionally does
// not distinguish a missing identity from a non-existent or wrong identity.
type AuthError struct {
	Code   string
	Status int
	Err    error
}

func (e *AuthError) Error() string { return e.Code }
func (e *AuthError) Unwrap() error { return e.Err }

func authError(code string, status int, err error) error {
	return &AuthError{Code: code, Status: status, Err: err}
}

// Principal is the authenticated owner identity. It contains no client-supplied
// identity fields other than the identity accepted by the trusted proxy.
type Principal struct{ OwnerID string }

// Config describes the only proxy assertions accepted by ExtractPrincipal.
type Config struct {
	OwnerID       string
	ForwardedHost string
}

func forwardedHostMatches(actual, configured string) bool {
	if actual == configured {
		return true
	}
	host, _, err := net.SplitHostPort(configured)
	return err == nil && actual == host
}

// ExtractPrincipal validates the local-proxy boundary and returns the configured
// owner. Identity in JSON, query parameters, X-Forwarded-For, or Host is ignored.
func ExtractPrincipal(r *http.Request, cfg Config) (Principal, error) {
	if r == nil || cfg.OwnerID == "" || cfg.ForwardedHost == "" || !ValidForwardedHost(cfg.ForwardedHost) {
		return Principal{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	if !loopbackRemote(r.RemoteAddr) {
		return Principal{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	if r.Header.Get(ForwardedProtoHeader) != "https" || !forwardedHostMatches(r.Header.Get(ForwardedHostHeader), cfg.ForwardedHost) {
		return Principal{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	userMatches := r.Header.Get(UserHeader) == cfg.OwnerID
	emailMatches := r.Header.Get(EmailHeader) == cfg.OwnerID
	if !userMatches && !emailMatches {
		return Principal{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	return Principal{OwnerID: cfg.OwnerID}, nil
}

// ValidForwardedHost reports whether host is an exact, single HTTP authority
// suitable for a trusted proxy configuration value.
func ValidForwardedHost(host string) bool {
	if host == "" || strings.TrimSpace(host) != host || strings.ContainsAny(host, ",/\\\r\n") {
		return false
	}
	// A configured host may include a port, but must be a real host authority.
	if strings.Contains(host, "@") {
		return false
	}
	if h, p, err := net.SplitHostPort(host); err == nil {
		return h != "" && p != ""
	}
	return !strings.Contains(host, ":") && net.ParseIP(host) == nil
}

func loopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ValidStableID applies the canonical identifier grammar used by V2 durable data.
func ValidStableID(id string) bool { return stableIDRE.MatchString(id) && !strings.Contains(id, "--") }
func ValidateStableID(id string) error {
	if !ValidStableID(id) {
		return ErrInvalidDeviceID
	}
	return nil
}

// GenerateDeviceToken deterministically derives a registration credential. The
// registration ID provides retry idempotence while the framed input prevents
// concatenation and cross-purpose/domain collisions.
func GenerateDeviceToken(masterKey []byte, ownerID, deviceID, registrationID string) (string, error) {
	if len(masterKey) < 32 {
		return "", ErrInvalidMasterKey
	}
	if ownerID == "" || !ValidStableID(deviceID) || registrationID == "" {
		return "", ErrInvalidDeviceID
	}
	mac := hmac.New(sha256.New, masterKey)
	mac.Write([]byte("songs-v2/device-token/v1\x00"))
	for _, part := range []string{ownerID, deviceID, registrationID} {
		mac.Write([]byte(fmt.Sprintf("%d:", len(part))))
		mac.Write([]byte(part))
	}
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// HashDeviceToken is the only representation that should be persisted.
func HashDeviceToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// VerifyDeviceToken compares a presented token against a stored SHA-256 hex
// digest. Invalid stored values fail closed and are never compared as plaintext.
func VerifyDeviceToken(token, storedHash string) bool {
	stored, err := hex.DecodeString(storedHash)
	if err != nil || len(stored) != sha256.Size {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	return hmac.Equal(sum[:], stored)
}

// ParseDeviceCredential reads only the dedicated credential headers.
type DeviceCredential struct{ DeviceID, Token string }

func ParseDeviceCredential(r *http.Request) (DeviceCredential, error) {
	if r == nil {
		return DeviceCredential{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	id, token := r.Header.Get(DeviceIDHeader), r.Header.Get(DeviceTokenHeader)
	if id == "" || token == "" || strings.TrimSpace(id) != id || strings.TrimSpace(token) != token || !ValidStableID(id) {
		return DeviceCredential{}, authError("UNAUTHENTICATED", http.StatusUnauthorized, ErrUnauthenticated)
	}
	return DeviceCredential{DeviceID: id, Token: token}, nil
}
