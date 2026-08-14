// v2publication-evidence runs the deterministic TASK-018 publication proof.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	value, err := runEvidence()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
