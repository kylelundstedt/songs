package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"songs.exe.dev/internal/v2bootstrap"
	"songs.exe.dev/internal/v2shell"
)

var flagListenAddr = flag.String("listen", "127.0.0.1:8001", "address for the isolated V2 read-only shell and API")

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
	shell, err := v2shell.LoadEmbedded(snapshot.Handler(), snapshot.ManifestSHA256())
	if err != nil {
		return fmt.Errorf("load reviewed V2 shell: %w", err)
	}
	server := &http.Server{
		Addr:              *flagListenAddr,
		Handler:           shell.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("starting isolated V2 read-only shell", "addr", server.Addr, "generation", snapshot.Generation(), "shell_release", shell.Release())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
