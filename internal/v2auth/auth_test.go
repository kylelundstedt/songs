package v2auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func request() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "https://internal.example/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set(ForwardedHostHeader, "v2.example.test:443")
	r.Header.Set(ForwardedProtoHeader, "https")
	r.Header.Set(UserHeader, "owner-1")
	return r
}

func TestExtractPrincipalTrustedBoundary(t *testing.T) {
	good := request()
	got, err := ExtractPrincipal(good, Config{OwnerID: "owner-1", ForwardedHost: "v2.example.test:443"})
	if err != nil || got.OwnerID != "owner-1" {
		t.Fatalf("success=(%+v,%v)", got, err)
	}
	cases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"absent host", func(r *http.Request) { r.Header.Del(ForwardedHostHeader) }},
		{"malformed host", func(r *http.Request) { r.Header.Set(ForwardedHostHeader, "v2.example.test:443,evil") }},
		{"forged host", func(r *http.Request) { r.Header.Set(ForwardedHostHeader, "evil.example") }},
		{"wrong proto", func(r *http.Request) { r.Header.Set(ForwardedProtoHeader, "http") }},
		{"missing user", func(r *http.Request) { r.Header.Del(UserHeader) }},
		{"forged user", func(r *http.Request) { r.Header.Set(UserHeader, "other") }},
		{"non-loopback", func(r *http.Request) { r.RemoteAddr = "203.0.113.9:10" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := request()
			tc.mutate(r)
			_, err := ExtractPrincipal(r, Config{OwnerID: "owner-1", ForwardedHost: "v2.example.test:443"})
			var ae *AuthError
			if !errors.As(err, &ae) || ae.Status != http.StatusUnauthorized {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestStableDeviceID(t *testing.T) {
	valid := []string{"a", "1device", "device-1", "a0-foo", "z" + string(make([]byte, 0))}
	for _, id := range valid {
		if !ValidStableID(id) {
			t.Errorf("valid ID rejected: %q", id)
		}
	}
	invalid := []string{"", "A", "a--b", "a_b", "a.b", "a/b", "a--", "a\n", "a" + string(make([]byte, 63))}
	for _, id := range invalid {
		if ValidStableID(id) {
			t.Errorf("invalid ID accepted: %q", id)
		}
	}
}

func TestDeterministicDeviceTokenAndDomainSeparation(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	a, err := GenerateDeviceToken(key, "owner-1", "device-1", "registration-1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := GenerateDeviceToken(key, "owner-1", "device-1", "registration-1")
	if a != b || len(a) != sha256.Size*2 {
		t.Fatalf("not deterministic: %q %q", a, b)
	}
	for _, parts := range [][3]string{{"owner-2", "device-1", "registration-1"}, {"owner-1", "device-2", "registration-1"}, {"owner-1", "device-1", "registration-2"}} {
		other, _ := GenerateDeviceToken(key, parts[0], parts[1], parts[2])
		if other == a {
			t.Fatal("token domain/input collision")
		}
	}
	if _, err := GenerateDeviceToken([]byte("short"), "owner-1", "device-1", "r"); !errors.Is(err, ErrInvalidMasterKey) {
		t.Fatalf("short key err=%v", err)
	}
}

func TestTokenHashAndConstantTimeVerification(t *testing.T) {
	token := "secret-device-token"
	hash := HashDeviceToken(token)
	want := sha256.Sum256([]byte(token))
	if hash != hex.EncodeToString(want[:]) {
		t.Fatal("hash is not SHA-256")
	}
	if !VerifyDeviceToken(token, hash) || VerifyDeviceToken("wrong", hash) || VerifyDeviceToken(token, "plaintext") {
		t.Fatal("token verification result incorrect")
	}
}

func TestParseDeviceCredentialDedicatedHeaders(t *testing.T) {
	r := request()
	r.Header.Set(DeviceIDHeader, "device-1")
	r.Header.Set(DeviceTokenHeader, "token")
	got, err := ParseDeviceCredential(r)
	if err != nil || got.DeviceID != "device-1" || got.Token != "token" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	q := request()
	q.URL.RawQuery = "device_id=device-1&token=token"
	if _, err := ParseDeviceCredential(q); err == nil {
		t.Fatal("query credential accepted")
	}
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del(DeviceIDHeader) },
		func(r *http.Request) { r.Header.Del(DeviceTokenHeader) },
		func(r *http.Request) { r.Header.Set(DeviceIDHeader, "../x") },
	} {
		q := request()
		q.Header.Set(DeviceIDHeader, "device-1")
		q.Header.Set(DeviceTokenHeader, "token")
		mutate(q)
		if _, err := ParseDeviceCredential(q); err == nil {
			t.Fatal("malformed credential accepted")
		}
	}
}
