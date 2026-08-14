package v2publish

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	"songs.exe.dev/internal/v2sync"
)

const maxPublicationSourceBytes = 1 << 20

// ParsePublicationPayload rejects duplicate keys, unknown keys, missing keys,
// unsafe paths, kind/path mismatches, and ambiguous source/deletion states.
func validatePayloadValue(payload PublicationPayload) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return codeError(CodeInvalidPayload, "encode publication payload", err)
	}
	parsed, err := ParsePublicationPayload(raw)
	if err != nil {
		return err
	}
	if parsed != payload {
		return codeError(CodeInvalidPayload, "publication payload does not round-trip exactly", nil)
	}
	return nil
}

func ParsePublicationPayload(raw []byte) (PublicationPayload, error) {
	_, canonical, err := v2sync.HashPayload(raw)
	if err != nil {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "publication payload is not canonical JSON-domain data", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(canonical, &fields); err != nil {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "decode publication payload fields", err)
	}
	required := []string{"schema_version", "kind", "path", "source", "deleted"}
	if len(fields) != len(required) {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "publication payload must contain exactly schema_version, kind, path, source, and deleted", nil)
	}
	for _, name := range required {
		if _, ok := fields[name]; !ok {
			return PublicationPayload{}, codeError(CodeInvalidPayload, "publication payload is missing "+name, nil)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	var payload PublicationPayload
	if err := decoder.Decode(&payload); err != nil {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "decode typed publication payload", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "publication payload has trailing JSON", err)
	}
	if payload.SchemaVersion != PayloadSchemaVersion {
		return PublicationPayload{}, codeError(CodeInvalidPayload, fmt.Sprintf("unsupported publication payload schema %q", payload.SchemaVersion), nil)
	}
	if payload.Kind != LeadSheet && payload.Kind != SetList {
		return PublicationPayload{}, codeError(CodeInvalidPayload, fmt.Sprintf("unsupported document kind %q", payload.Kind), nil)
	}
	if err := ValidatePublicationPath(payload.Kind, payload.Path); err != nil {
		return PublicationPayload{}, err
	}
	if !utf8.ValidString(payload.Source) || strings.ContainsRune(payload.Source, 0) || len(payload.Source) > maxPublicationSourceBytes {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "source must be bounded UTF-8 without NUL", nil)
	}
	if payload.Deleted && payload.Source != "" {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "deleted publication must have empty source", nil)
	}
	if !payload.Deleted && payload.Source == "" {
		return PublicationPayload{}, codeError(CodeInvalidPayload, "non-deleted publication must have source", nil)
	}
	return payload, nil
}

func ValidatePublicationPath(kind DocumentKind, value string) error {
	if value == "" || len(value) > 240 || !utf8.ValidString(value) || strings.ContainsRune(value, 0) || strings.Contains(value, "\\") || strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return codeError(CodeInvalidPayload, "publication path is not a clean relative slash path", nil)
	}
	parts := strings.Split(value, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || parts[1] == "." || parts[1] == ".." || strings.HasPrefix(parts[1], ".") || !strings.HasSuffix(parts[1], ".md") {
		return codeError(CodeInvalidPayload, "publication path must be one Markdown file below its canonical directory", nil)
	}
	for _, r := range strings.TrimSuffix(parts[1], ".md") {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-'_", r)) {
			return codeError(CodeInvalidPayload, "publication filename contains an unsafe character", nil)
		}
	}
	expected := "songs"
	if kind == SetList {
		expected = "sets"
	}
	if parts[0] != expected {
		return codeError(CodeInvalidPayload, fmt.Sprintf("%s payload path must be below %s/", kind, expected), nil)
	}
	return nil
}

func sourceHash(source []byte) string {
	digest := sha256.Sum256(source)
	return hex.EncodeToString(digest[:])
}

func publicationIntentID(owner, document, revision string) string {
	digest := sha256.Sum256([]byte(owner + "\x00" + document + "\x00" + revision))
	return "pub-" + hex.EncodeToString(digest[:16])
}

func externalOperationID(owner, document, commit string) string {
	digest := sha256.Sum256([]byte("external-operation\x00" + owner + "\x00" + document + "\x00" + commit))
	return "external-" + hex.EncodeToString(digest[:12])
}

func externalRevisionID(owner, document, commit, candidatePath string, deleted bool, source []byte) string {
	material := owner + "\x00" + document + "\x00" + commit + "\x00" + candidatePath + "\x00" + fmt.Sprint(deleted) + "\x00" + sourceHash(source)
	digest := sha256.Sum256([]byte(material))
	return "ext-" + hex.EncodeToString(digest[:12])
}

func unownedAdditionID(owner, commit, candidatePath string, source []byte) string {
	digest := sha256.Sum256([]byte(owner + "\x00" + commit + "\x00" + candidatePath + "\x00" + sourceHash(source)))
	return "add-" + hex.EncodeToString(digest[:12])
}

func reconciliationID(owner, document, commit string) string {
	digest := sha256.Sum256([]byte(owner + "\x00" + document + "\x00" + commit))
	return "rec-" + hex.EncodeToString(digest[:12])
}

func reconciliationConflictID(owner, document, commit string) string {
	digest := sha256.Sum256([]byte("conflict\x00" + owner + "\x00" + document + "\x00" + commit))
	return "recon-" + hex.EncodeToString(digest[:12])
}
