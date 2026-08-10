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
)

var flagListenAddr = flag.String("listen", ":8001", "address for the isolated V2 read-only API")

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
	server := &http.Server{
		Addr:              *flagListenAddr,
		Handler:           snapshot.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("starting isolated V2 read-only API", "addr", server.Addr, "generation", snapshot.Generation())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
