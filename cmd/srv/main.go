package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"songs.exe.dev/srv"
)

var flagListenAddr = flag.String("listen", ":8000", "address to listen on")
var flagRepoRoot = flag.String("repo", "", "repository root (defaults to current directory)")
var flagDB = flag.String("db", "", "SQLite path (defaults to <repo>/var/songs.sqlite3)")

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	flag.Parse()
	root := *flagRepoRoot
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			return fmt.Errorf("working directory: %w", err)
		}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("repository path: %w", err)
	}
	dbPath := *flagDB
	if dbPath == "" {
		dbPath = filepath.Join(root, "var", "songs.sqlite3")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	server, err := srv.New(dbPath, hostname, root)
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}
	return server.Serve(*flagListenAddr)
}
