package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"songs.exe.dev/internal/v2bootstrap"
	"songs.exe.dev/internal/v2shell"
	"songs.exe.dev/internal/v2sync"
	"songs.exe.dev/internal/v2syncapi"
)

var flagListenAddr = flag.String("listen", "127.0.0.1:8001", "address for the isolated V2 shell and API")
var flagSyncEnabled = flag.Bool("sync-enabled", false, "enable the writable V2 sync API (disabled by default)")
var flagSyncDB = flag.String("sync-db", "", "durable V2 sync SQLite path (required when sync is enabled)")
var flagSyncOwner = flag.String("sync-owner", "", "exact trusted proxy owner ID (required when sync is enabled)")
var flagSyncForwardedHost = flag.String("sync-forwarded-host", "", "exact trusted forwarded host (required when sync is enabled)")
var flagSyncMasterKeyFile = flag.String("sync-master-key-file", "", "0600 file containing a 64-character hex master key (required when sync is enabled)")
var flagWritableEnabled = flag.Bool("writable-enabled", false, "expose browser Set List authoring controls (requires sync; disabled by default)")

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	flag.Parse()
	snapshot, err := v2bootstrap.LoadEmbedded()
	if err != nil {
		return fmt.Errorf("load reviewed V2 bootstrap snapshot: %w", err)
	}
	api := snapshot.Handler()
	var syncStore *v2sync.Store
	if *flagWritableEnabled && !*flagSyncEnabled {
		return errors.New("writable browser controls require -sync-enabled")
	}
	if *flagSyncEnabled {
		syncHandler, store, err := loadSyncHandler()
		if err != nil {
			return err
		}
		syncStore = store
		defer syncStore.Close()
		api = routeV2API(snapshot.Handler(), syncHandler, *flagWritableEnabled)
	} else if *flagSyncDB != "" || *flagSyncOwner != "" || *flagSyncForwardedHost != "" || *flagSyncMasterKeyFile != "" {
		return errors.New("sync configuration was supplied without -sync-enabled")
	}
	shell, err := v2shell.LoadEmbedded(api, snapshot.ManifestSHA256())
	if err != nil {
		return fmt.Errorf("load reviewed V2 shell: %w", err)
	}
	server := &http.Server{
		Addr:              *flagListenAddr,
		Handler:           shell.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("starting isolated V2 shell", "addr", server.Addr, "generation", snapshot.Generation(), "shell_release", shell.Release(), "sync_enabled", *flagSyncEnabled, "writable_enabled", *flagWritableEnabled)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

const writableCapabilitiesPath = "/api/v2/writable-capabilities"

func routeV2API(readOnly, sync http.Handler, writable bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == writableCapabilitiesPath {
			if r.Method != http.MethodGet || r.URL.RawQuery != "" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = fmt.Fprintf(w, `{"schema_version":"1","set_list_authoring":%t,"foreground_sync":%t}`+"\n", writable, writable)
			return
		}
		if r.URL.Path == v2syncapi.PathPrefix || strings.HasPrefix(r.URL.Path, v2syncapi.PathPrefix+"/") {
			sync.ServeHTTP(w, r)
			return
		}
		readOnly.ServeHTTP(w, r)
	})
}

func loadSyncHandler() (http.Handler, *v2sync.Store, error) {
	if *flagSyncDB == "" || *flagSyncOwner == "" || *flagSyncForwardedHost == "" || *flagSyncMasterKeyFile == "" {
		return nil, nil, errors.New("sync requires -sync-db, -sync-owner, -sync-forwarded-host, and -sync-master-key-file")
	}
	info, err := os.Stat(*flagSyncMasterKeyFile)
	if err != nil {
		return nil, nil, fmt.Errorf("stat sync master key file: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, nil, errors.New("sync master key file must not be group/world accessible")
	}
	raw, err := os.ReadFile(*flagSyncMasterKeyFile)
	if err != nil {
		return nil, nil, fmt.Errorf("read sync master key file: %w", err)
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) < 32 {
		return nil, nil, errors.New("sync master key file must contain at least 32 bytes encoded as hex")
	}
	store, err := v2sync.Open(*flagSyncDB)
	if err != nil {
		return nil, nil, fmt.Errorf("open durable V2 sync store: %w", err)
	}
	handler, err := v2syncapi.New(store, v2syncapi.Config{
		Store: store, OwnerID: *flagSyncOwner, ForwardedHost: *flagSyncForwardedHost, MasterKey: key,
	})
	for i := range key {
		key[i] = 0
	}
	if err != nil {
		_ = store.Close()
		return nil, nil, fmt.Errorf("configure writable V2 sync API: %w", err)
	}
	return handler, store, nil
}
