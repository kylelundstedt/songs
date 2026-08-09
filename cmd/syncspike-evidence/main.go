// syncspike-evidence runs the disposable TASK-005 proof and writes canonical JSON to stdout.
package main

import (
	"fmt"
	"os"

	"songs.exe.dev/internal/syncspike"
)

func main() {
	root, err := os.MkdirTemp("", "songs-v2-sync-spike-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(root)
	result, err := syncspike.RunScenario(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded, err := syncspike.CanonicalEvidence(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(encoded); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
