package main

import (
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"songs.exe.dev/internal/v2bootstrap"
	"songs.exe.dev/internal/v2shell"
	"songs.exe.dev/internal/v2syncapi"
)

func TestRouteV2APIDispatch(t *testing.T) {
	readOnly := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("read-only"))
	})
	syncHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("sync"))
	})
	handler := routeV2API(readOnly, syncHandler)

	for _, tc := range []struct {
		path string
		want string
	}{
		{v2syncapi.PathPrefix, "sync"},
		{v2syncapi.PathPrefix + "/", "sync"},
		{v2syncapi.PathPrefix + "/health", "sync"},
		{v2syncapi.PathPrefix + "//health", "sync"},
		{"/api/v2/bootstrap/manifest", "read-only"},
		{v2syncapi.PathPrefix + "ish", "read-only"},
		{v2syncapi.PathPrefix + "-other", "read-only"},
		{"/api/v2/syn", "read-only"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if got := response.Body.String(); got != tc.want {
				t.Fatalf("route %q reached %q handler, want %q", tc.path, got, tc.want)
			}
		})
	}
}

func TestSyncProductionDefaultsRemainReadOnly(t *testing.T) {
	if got := flag.Lookup("sync-enabled"); got == nil || got.DefValue != "false" {
		t.Fatalf("sync-enabled default = %v, want false", got)
	}
	for _, name := range []string{"sync-db", "sync-owner", "sync-forwarded-host", "sync-master-key-file"} {
		if got := flag.Lookup(name); got == nil || got.DefValue != "" {
			t.Errorf("%s default = %v, want empty", name, got)
		}
	}

	// This is the same handler composition run uses while sync-enabled is false:
	// the reviewed bootstrap API is passed directly to the shell, with no sync
	// router installed.
	snapshot, err := v2bootstrap.LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	shell, err := v2shell.LoadEmbedded(snapshot.Handler(), snapshot.ManifestSHA256())
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, v2syncapi.PathPrefix+"/health", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "v2.example.test")
	request.Header.Set("X-ExeDev-UserID", "owner-1")
	response := httptest.NewRecorder()
	shell.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("default sync route status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if !strings.Contains(response.Body.String(), "bootstrap resource not found") {
		t.Fatalf("default sync route unexpectedly escaped read-only API: %s", response.Body.String())
	}
}

type syncFlagValues struct {
	enabled       bool
	database      string
	owner         string
	forwardedHost string
	keyFile       string
}

var syncFlagTestMu sync.Mutex

func withSyncFlags(t *testing.T, values syncFlagValues, test func()) {
	t.Helper()
	syncFlagTestMu.Lock()
	old := syncFlagValues{
		enabled:       *flagSyncEnabled,
		database:      *flagSyncDB,
		owner:         *flagSyncOwner,
		forwardedHost: *flagSyncForwardedHost,
		keyFile:       *flagSyncMasterKeyFile,
	}
	defer func() {
		*flagSyncEnabled = old.enabled
		*flagSyncDB = old.database
		*flagSyncOwner = old.owner
		*flagSyncForwardedHost = old.forwardedHost
		*flagSyncMasterKeyFile = old.keyFile
		syncFlagTestMu.Unlock()
	}()
	*flagSyncEnabled = values.enabled
	*flagSyncDB = values.database
	*flagSyncOwner = values.owner
	*flagSyncForwardedHost = values.forwardedHost
	*flagSyncMasterKeyFile = values.keyFile
	test()
}

func TestRunRejectsSyncConfigurationWhileDisabled(t *testing.T) {
	configured := syncFlagValues{
		database:      "sync.db",
		owner:         "owner-1",
		forwardedHost: "v2.example.test",
		keyFile:       "master.key",
	}
	for _, tc := range []struct {
		name   string
		values syncFlagValues
	}{
		{"database only", syncFlagValues{database: configured.database}},
		{"owner only", syncFlagValues{owner: configured.owner}},
		{"forwarded host only", syncFlagValues{forwardedHost: configured.forwardedHost}},
		{"key file only", syncFlagValues{keyFile: configured.keyFile}},
		{"complete configuration", configured},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withSyncFlags(t, tc.values, func() {
				err := run()
				if err == nil || err.Error() != "sync configuration was supplied without -sync-enabled" {
					t.Fatalf("run error = %v, want disabled-sync configuration rejection", err)
				}
			})
		})
	}
}

func TestLoadSyncHandlerRequiresCompleteConfiguration(t *testing.T) {
	temp := t.TempDir()
	keyFile := filepath.Join(temp, "master.key")
	writeKeyFile(t, keyFile, strings.Repeat("01", 32), 0o600)
	complete := syncFlagValues{
		enabled:       true,
		database:      filepath.Join(temp, "sync.db"),
		owner:         "owner-1",
		forwardedHost: "v2.example.test",
		keyFile:       keyFile,
	}
	for _, tc := range []struct {
		name   string
		mutate func(*syncFlagValues)
	}{
		{"database", func(v *syncFlagValues) { v.database = "" }},
		{"owner", func(v *syncFlagValues) { v.owner = "" }},
		{"forwarded host", func(v *syncFlagValues) { v.forwardedHost = "" }},
		{"key file", func(v *syncFlagValues) { v.keyFile = "" }},
	} {
		t.Run("missing "+tc.name, func(t *testing.T) {
			values := complete
			tc.mutate(&values)
			withSyncFlags(t, values, func() {
				handler, store, err := loadSyncHandler()
				if handler != nil || store != nil {
					t.Fatalf("incomplete configuration returned handler=%v store=%v", handler, store)
				}
				const want = "sync requires -sync-db, -sync-owner, -sync-forwarded-host, and -sync-master-key-file"
				if err == nil || err.Error() != want {
					t.Fatalf("loadSyncHandler error = %v, want %q", err, want)
				}
			})
		})
	}
}

func TestLoadSyncHandlerRejectsAccessibleMasterKeyFile(t *testing.T) {
	for _, mode := range []os.FileMode{0o640, 0o604, 0o610} {
		t.Run(mode.String(), func(t *testing.T) {
			temp := t.TempDir()
			keyFile := filepath.Join(temp, "master.key")
			writeKeyFile(t, keyFile, strings.Repeat("ab", 32), mode)
			database := filepath.Join(temp, "sync.db")
			withSyncFlags(t, validSyncFlagValues(database, keyFile), func() {
				handler, store, err := loadSyncHandler()
				if handler != nil || store != nil {
					t.Fatalf("accessible key returned handler=%v store=%v", handler, store)
				}
				if err == nil || err.Error() != "sync master key file must not be group/world accessible" {
					t.Fatalf("loadSyncHandler error = %v, want key permission rejection", err)
				}
				if _, statErr := os.Stat(database); !os.IsNotExist(statErr) {
					t.Fatalf("database was touched before key permissions were rejected: %v", statErr)
				}
			})
		})
	}
}

func TestLoadSyncHandlerValidatesMasterKeyContents(t *testing.T) {
	for _, tc := range []struct {
		name string
		key  string
	}{
		{"non-hex", strings.Repeat("zz", 32)},
		{"odd-length hex", strings.Repeat("a", 63)},
		{"short hex", strings.Repeat("ab", 31)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			temp := t.TempDir()
			keyFile := filepath.Join(temp, "master.key")
			writeKeyFile(t, keyFile, tc.key, 0o600)
			database := filepath.Join(temp, "sync.db")
			withSyncFlags(t, validSyncFlagValues(database, keyFile), func() {
				handler, store, err := loadSyncHandler()
				if handler != nil || store != nil {
					t.Fatalf("invalid key returned handler=%v store=%v", handler, store)
				}
				if err == nil || err.Error() != "sync master key file must contain at least 32 bytes encoded as hex" {
					t.Fatalf("loadSyncHandler error = %v, want key content rejection", err)
				}
				if _, statErr := os.Stat(database); !os.IsNotExist(statErr) {
					t.Fatalf("database was touched before key contents were rejected: %v", statErr)
				}
			})
		})
	}
}

func TestLoadSyncHandlerAcceptsCompleteEnabledConfiguration(t *testing.T) {
	temp := t.TempDir()
	keyFile := filepath.Join(temp, "master.key")
	// Whitespace around the documented 64 hexadecimal characters is accepted.
	writeKeyFile(t, keyFile, strings.Repeat("cd", 32)+"\n", 0o600)
	database := filepath.Join(temp, "state", "sync.db")
	withSyncFlags(t, validSyncFlagValues(database, keyFile), func() {
		handler, store, err := loadSyncHandler()
		if err != nil {
			t.Fatalf("loadSyncHandler: %v", err)
		}
		if handler == nil || store == nil {
			t.Fatalf("complete configuration returned handler=%v store=%v", handler, store)
		}
		if err := store.Close(); err != nil {
			t.Fatalf("close sync store: %v", err)
		}
		if _, err := os.Stat(database); err != nil {
			t.Fatalf("durable database was not created: %v", err)
		}
	})
}

func TestLoadSyncHandlerRejectsInvalidOwnerConfiguration(t *testing.T) {
	temp := t.TempDir()
	keyFile := filepath.Join(temp, "master.key")
	writeKeyFile(t, keyFile, strings.Repeat("ef", 32), 0o600)
	values := validSyncFlagValues(filepath.Join(temp, "sync.db"), keyFile)
	values.owner = " owner-1"
	withSyncFlags(t, values, func() {
		handler, store, err := loadSyncHandler()
		if handler != nil || store != nil {
			t.Fatalf("invalid owner returned handler=%v store=%v", handler, store)
		}
		if err == nil || !strings.Contains(err.Error(), "configure writable V2 sync API") {
			t.Fatalf("loadSyncHandler error = %v, want owner configuration rejection", err)
		}
	})
}

func TestLoadSyncHandlerRejectsMalformedForwardedHost(t *testing.T) {
	temp := t.TempDir()
	keyFile := filepath.Join(temp, "master.key")
	writeKeyFile(t, keyFile, strings.Repeat("ef", 32), 0o600)
	values := validSyncFlagValues(filepath.Join(temp, "sync.db"), keyFile)
	values.forwardedHost = "bad,host"
	withSyncFlags(t, values, func() {
		handler, store, err := loadSyncHandler()
		if handler != nil || store != nil {
			t.Fatalf("malformed forwarded host returned handler=%v store=%v", handler, store)
		}
		if err == nil || !strings.Contains(err.Error(), "invalid forwarded host") {
			t.Fatalf("loadSyncHandler error = %v, want forwarded-host configuration rejection", err)
		}
	})
}

func validSyncFlagValues(database, keyFile string) syncFlagValues {
	return syncFlagValues{
		enabled:       true,
		database:      database,
		owner:         "owner-1",
		forwardedHost: "v2.example.test",
		keyFile:       keyFile,
	}
}

func writeKeyFile(t *testing.T, path, contents string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	// Chmod makes the test independent of the process umask.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}
