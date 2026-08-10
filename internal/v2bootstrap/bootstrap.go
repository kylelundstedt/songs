package v2bootstrap

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

//go:embed data/manifest.json data/chunks/*.json
var embedded embed.FS

const (
	expectedManifestSHA256 = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f"
	expectedGeneration     = "phase1-f9634173e25ef4ca4b8330a3"
	expectedSnapshotSHA256 = "f9634173e25ef4ca4b8330a343ac1e2bf493880a2ad6ef4239e3540ee8400a49"
	expectedTask009Commit  = "2cbf78adac34fab94487a7b06a782907a257303b"
)

type ErrorCode string

const (
	ErrSchemaUnsupported ErrorCode = "SCHEMA_UNSUPPORTED"
	ErrManifestInvalid   ErrorCode = "MANIFEST_INVALID"
	ErrChunkMissing      ErrorCode = "CHUNK_MISSING"
	ErrChunkUnexpected   ErrorCode = "CHUNK_UNEXPECTED"
	ErrChunkOrder        ErrorCode = "CHUNK_ORDER_INVALID"
	ErrChunkHash         ErrorCode = "CHUNK_HASH_MISMATCH"
	ErrDocumentInvalid   ErrorCode = "DOCUMENT_INVALID"
	ErrSnapshotInvalid   ErrorCode = "SNAPSHOT_INVALID"
)

type LoadError struct {
	Code ErrorCode
	Path string
	Err  error
}

func (e *LoadError) Error() string {
	if e.Path != "" {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Path, e.Err)
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}
func (e *LoadError) Unwrap() error { return e.Err }

func loadFail(code ErrorCode, path, message string) error {
	return &LoadError{Code: code, Path: path, Err: errors.New(message)}
}

type baseline struct {
	Ref       string `json:"ref"`
	TagObject string `json:"tag_object"`
	Commit    string `json:"commit"`
}

type readModelAnchor struct {
	ImplementationCommit     string `json:"implementation_commit"`
	ImportReportFileSHA256   string `json:"import_report_file_sha256"`
	ImportReportOutputSHA256 string `json:"import_report_output_sha256"`
}

type contractHashes struct {
	CorpusManifest      string `json:"corpus_manifest"`
	IdentitySidecars    string `json:"identity_sidecars"`
	ReadModelProjection string `json:"read_model_projection"`
}

type fitCaptureHashes struct {
	IPadLandscape string `json:"ipad-landscape"`
	IPadPortrait  string `json:"ipad-portrait"`
	Phone         string `json:"phone"`
}

type evidenceHashes struct {
	BrowserFitSummary string           `json:"browser_fit_summary"`
	FitCaptures       fitCaptureHashes `json:"fit_captures"`
	RendererBaseline  string           `json:"renderer_baseline"`
}

type apexIdentity struct {
	ExecutableSHA256 string   `json:"executable_sha256"`
	Flags            []string `json:"flags"`
	VersionOutput    string   `json:"version_output"`
}

type physicalIPad struct {
	Note   string `json:"note"`
	Status string `json:"status"`
}

type counts struct {
	Documents   int `json:"documents"`
	LeadSheets  int `json:"lead_sheets"`
	SetLists    int `json:"set_lists"`
	SetSections int `json:"set_sections"`
	SetEntries  int `json:"set_entries"`
	SourceBytes int `json:"source_bytes"`
}

type chunkDescriptor struct {
	Index         int    `json:"index"`
	Path          string `json:"path"`
	URL           string `json:"url"`
	SHA256        string `json:"sha256"`
	Bytes         int    `json:"bytes"`
	SourceBytes   int    `json:"source_bytes"`
	DocumentCount int    `json:"document_count"`
	FirstPath     string `json:"first_path"`
	LastPath      string `json:"last_path"`
}

type slugRoute struct {
	Kind       string `json:"kind"`
	Slug       string `json:"slug"`
	Path       string `json:"path"`
	DocumentID string `json:"documentId"`
}

type manifest struct {
	SchemaVersion    string            `json:"schema_version"`
	Kind             string            `json:"kind"`
	Generation       string            `json:"generation"`
	SourceBaseline   baseline          `json:"source_baseline"`
	EvidenceBaseline baseline          `json:"evidence_baseline"`
	ReadModelAnchor  readModelAnchor   `json:"read_model_anchor"`
	Counts           counts            `json:"counts"`
	ContractHashes   contractHashes    `json:"contract_hashes"`
	EvidenceHashes   evidenceHashes    `json:"evidence_hashes"`
	Apex             apexIdentity      `json:"apex"`
	PhysicalIPad     physicalIPad      `json:"physical_ipad"`
	SlugRoutes       []slugRoute       `json:"slug_routes"`
	Chunks           []chunkDescriptor `json:"chunks"`
	SnapshotSHA256   string            `json:"snapshot_sha256"`
	Verification     struct {
		OutputSHA256 string `json:"output_sha256"`
	} `json:"verification"`
}

type sourceEnvelope struct {
	Ref           string `json:"ref"`
	Commit        string `json:"commit"`
	SHA256        string `json:"sha256"`
	Bytes         int    `json:"bytes"`
	ContentBase64 string `json:"content_base64"`
}

type apexRender struct {
	SourceSHA256 string `json:"source_sha256"`
	HTML         string `json:"html"`
	SHA256       string `json:"sha256"`
	Bytes        int    `json:"bytes"`
}

type fitBox struct {
	ClientWidth  int `json:"client_width"`
	ClientHeight int `json:"client_height"`
	ScrollWidth  int `json:"scroll_width"`
	ScrollHeight int `json:"scroll_height"`
}

type fitResult struct {
	Profile      string      `json:"profile"`
	Status       string      `json:"status"`
	BodyPX       int         `json:"body_px"`
	AutoBodyPX   int         `json:"auto_body_px"`
	LineHeight   json.Number `json:"line_height"`
	ColumnCount  int         `json:"column_count"`
	ClientWidth  int         `json:"client_width"`
	ClientHeight int         `json:"client_height"`
	ScrollWidth  int         `json:"scroll_width"`
	ScrollHeight int         `json:"scroll_height"`
	Columns      []fitBox    `json:"columns"`
}

type fitEvidence struct {
	SourceSHA256 string      `json:"source_sha256"`
	Profiles     []fitResult `json:"profiles"`
}

type document struct {
	Ordinal      int             `json:"ordinal"`
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	Path         string          `json:"path"`
	Slug         string          `json:"slug"`
	Source       sourceEnvelope  `json:"source"`
	Projection   json.RawMessage `json:"projection"`
	Apex         *apexRender     `json:"apex"`
	Fit          *fitEvidence    `json:"fit"`
	Verification struct {
		ProjectionSHA256 string `json:"projection_sha256"`
		DocumentSHA256   string `json:"document_sha256"`
	} `json:"verification"`
}

type chunk struct {
	SchemaVersion string     `json:"schema_version"`
	Kind          string     `json:"kind"`
	Generation    string     `json:"generation"`
	Index         int        `json:"index"`
	Documents     []document `json:"documents"`
	Verification  struct {
		DocumentsSHA256 string `json:"documents_sha256"`
		OutputSHA256    string `json:"output_sha256"`
	} `json:"verification"`
}

type Snapshot struct {
	manifest     []byte
	chunks       map[string][]byte
	chunkETags   map[string]string
	generation   string
	manifestETag string
}

func LoadEmbedded() (*Snapshot, error) { return Load(embedded) }

func Load(files fs.FS) (*Snapshot, error) {
	manifestRaw, err := fs.ReadFile(files, "data/manifest.json")
	if err != nil {
		return nil, &LoadError{Code: ErrManifestInvalid, Path: "data/manifest.json", Err: err}
	}
	if digest(manifestRaw) != expectedManifestSHA256 {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "manifest does not match the reviewed runtime trust anchor")
	}
	if err := rejectDuplicateKeys(manifestRaw); err != nil {
		return nil, &LoadError{Code: ErrManifestInvalid, Path: "data/manifest.json", Err: err}
	}
	if err := requireCanonicalJSON(manifestRaw); err != nil {
		return nil, &LoadError{Code: ErrManifestInvalid, Path: "data/manifest.json", Err: err}
	}
	var manifestValue manifest
	if err := strictDecode(manifestRaw, &manifestValue); err != nil {
		return nil, &LoadError{Code: ErrManifestInvalid, Path: "data/manifest.json", Err: err}
	}
	if manifestValue.SchemaVersion != "1" || manifestValue.Kind != "songs-v2.bootstrap.manifest" {
		return nil, loadFail(ErrSchemaUnsupported, "data/manifest.json", "unsupported manifest schema")
	}
	if manifestValue.SourceBaseline != (baseline{Ref: "v2-phase1-content-2026-08-10", TagObject: "62f715002da4ca54bb3f01d34489514fe671cdf7", Commit: "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5"}) || manifestValue.EvidenceBaseline != (baseline{Ref: "v2-phase1-evidence-2026-08-10", TagObject: "6a758e72a54f870c574c5ee6a0e20d9fd35af5b5", Commit: "5ea535b53b94445084586828389f44c1a5136877"}) {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "frozen baseline drift")
	}
	if manifestValue.ReadModelAnchor != (readModelAnchor{ImplementationCommit: expectedTask009Commit, ImportReportFileSHA256: "bd1c8fc5efa078aea9fb5811fbc055349ac42f642103922a6dd08a564dc61490", ImportReportOutputSHA256: "cfae83238b91223c7f1f05b82adf406d0d69c4d8e69d155e0b028b1d617a632c"}) || manifestValue.ContractHashes != (contractHashes{CorpusManifest: "a3989f52ab23d8d3be31c9df258faa6a564c82ceadb1bee6f0b8e03dce0f1a35", IdentitySidecars: "0a4b95ae549aaf41286d41754d08cb4f66256abf84f39b30015d656014d640b6", ReadModelProjection: "9422631c30d13999f8b7bce42a2b12857adbee36be698ac5ba2ea0194961fa80"}) {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "TASK-009 contract anchor drift")
	}
	if manifestValue.EvidenceHashes != (evidenceHashes{BrowserFitSummary: "d80941d7fea462e32d1fdea0306d616c06b349562ad90836457a91794356b77d", FitCaptures: fitCaptureHashes{IPadLandscape: "8fb3163f1730f919f3158077a053ac65333da637d77c71d522d861993afbcb7e", IPadPortrait: "c47a54149645a8c416117ab91b955e630ca03ef78e45496e335b0381d8aa5332", Phone: "e212471dba2066a7a3849bc0bd0aaebced10935886d012187bf5434e00673a6f"}, RendererBaseline: "bc1c68fa4c691cff8678aafcfaaa25b2ed2a2ad2a4b0405e3228d8dad5a6371e"}) {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "frozen evidence hash drift")
	}
	if manifestValue.Generation != expectedGeneration || manifestValue.SnapshotSHA256 != expectedSnapshotSHA256 || manifestValue.PhysicalIPad.Status != "pending" || manifestValue.Apex.ExecutableSHA256 != "dbe29df956939a0133e17ed558b8be5901fd20757cbc065161c290b6fa136a14" || strings.Join(manifestValue.Apex.Flags, "\x00") != strings.Join([]string{"--no-plugins", "--no-unsafe", "--aria", "--mode", "unified", "--to", "html"}, "\x00") {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "reviewed snapshot identity drift")
	}
	if manifestValue.Counts != (counts{Documents: 373, LeadSheets: 339, SetLists: 34, SetSections: 36, SetEntries: 1076, SourceBytes: 748034}) {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "frozen counts drift")
	}
	if got, err := nullHash(manifestRaw, "verification", "output_sha256"); err != nil || got != manifestValue.Verification.OutputSHA256 {
		return nil, loadFail(ErrManifestInvalid, "data/manifest.json", "manifest self-hash mismatch")
	}

	entries, err := fs.ReadDir(files, "data/chunks")
	if err != nil {
		return nil, &LoadError{Code: ErrChunkMissing, Path: "data/chunks", Err: err}
	}
	actualFiles := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() {
			return nil, loadFail(ErrChunkUnexpected, "data/chunks/"+entry.Name(), "unexpected directory")
		}
		actualFiles[entry.Name()] = true
	}
	chunks := make(map[string][]byte, len(manifestValue.Chunks))
	chunkETags := make(map[string]string, len(manifestValue.Chunks))
	allDocuments := make([]document, 0, manifestValue.Counts.Documents)
	documentGeneric := make([]any, 0, manifestValue.Counts.Documents)
	for expectedIndex, descriptor := range manifestValue.Chunks {
		expectedName := fmt.Sprintf("chunk-%03d.json", expectedIndex)
		if descriptor.Index != expectedIndex || descriptor.Path != expectedName || descriptor.URL != fmt.Sprintf("/api/v2/bootstrap/%s/chunks/%s", manifestValue.Generation, expectedName) {
			return nil, loadFail(ErrChunkOrder, descriptor.Path, "chunk descriptor order mismatch")
		}
		if !actualFiles[descriptor.Path] {
			return nil, loadFail(ErrChunkMissing, descriptor.Path, "referenced chunk is missing")
		}
		delete(actualFiles, descriptor.Path)
		raw, err := fs.ReadFile(files, "data/chunks/"+descriptor.Path)
		if err != nil {
			return nil, &LoadError{Code: ErrChunkMissing, Path: descriptor.Path, Err: err}
		}
		if len(raw) != descriptor.Bytes || digest(raw) != descriptor.SHA256 {
			return nil, loadFail(ErrChunkHash, descriptor.Path, "raw chunk hash mismatch")
		}
		if err := rejectDuplicateKeys(raw); err != nil {
			return nil, &LoadError{Code: ErrChunkHash, Path: descriptor.Path, Err: err}
		}
		if err := requireCanonicalJSON(raw); err != nil {
			return nil, &LoadError{Code: ErrChunkHash, Path: descriptor.Path, Err: err}
		}
		var value chunk
		if err := strictDecode(raw, &value); err != nil {
			return nil, &LoadError{Code: ErrChunkHash, Path: descriptor.Path, Err: err}
		}
		if value.SchemaVersion != "1" || value.Kind != "songs-v2.bootstrap.chunk" {
			return nil, loadFail(ErrSchemaUnsupported, descriptor.Path, "unsupported chunk schema")
		}
		if value.Generation != manifestValue.Generation || value.Index != expectedIndex || len(value.Documents) != descriptor.DocumentCount {
			return nil, loadFail(ErrChunkOrder, descriptor.Path, "chunk identity mismatch")
		}
		if got, err := nullHash(raw, "verification", "output_sha256"); err != nil || got != value.Verification.OutputSHA256 {
			return nil, loadFail(ErrChunkHash, descriptor.Path, "chunk self-hash mismatch")
		}
		var generic map[string]any
		if err := decodeUseNumber(raw, &generic); err != nil {
			return nil, &LoadError{Code: ErrChunkHash, Path: descriptor.Path, Err: err}
		}
		genericDocs, ok := generic["documents"].([]any)
		if !ok || len(genericDocs) != len(value.Documents) {
			return nil, loadFail(ErrChunkHash, descriptor.Path, "chunk document encoding mismatch")
		}
		documentHashes := make([]string, 0, len(value.Documents))
		sourceBytes := 0
		for index, doc := range value.Documents {
			documentHashes = append(documentHashes, doc.Verification.DocumentSHA256)
			sourceBytes += doc.Source.Bytes
			allDocuments = append(allDocuments, doc)
			documentGeneric = append(documentGeneric, genericDocs[index])
		}
		if framedDigest(documentHashes) != value.Verification.DocumentsSHA256 || sourceBytes != descriptor.SourceBytes || len(value.Documents) == 0 || value.Documents[0].Path != descriptor.FirstPath || value.Documents[len(value.Documents)-1].Path != descriptor.LastPath {
			return nil, loadFail(ErrChunkOrder, descriptor.Path, "chunk descriptor contents mismatch")
		}
		chunks[descriptor.Path] = bytes.Clone(raw)
		chunkETags[descriptor.Path] = `"` + descriptor.SHA256 + `"`
	}
	if len(actualFiles) != 0 {
		names := make([]string, 0, len(actualFiles))
		for name := range actualFiles {
			names = append(names, name)
		}
		sort.Strings(names)
		return nil, loadFail(ErrChunkUnexpected, names[0], "unreferenced chunk")
	}
	if err := validateDocuments(manifestValue, allDocuments, documentGeneric); err != nil {
		return nil, err
	}
	return &Snapshot{
		manifest: bytes.Clone(manifestRaw), chunks: chunks, chunkETags: chunkETags,
		generation: manifestValue.Generation, manifestETag: `"` + digest(manifestRaw) + `"`,
	}, nil
}

func validateDocuments(m manifest, documents []document, generic []any) error {
	ids, paths, leadIDs, entryIDs := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	documentsByID := map[string]document{}
	var previous string
	leadSheets, setLists, sections, entries, sourceBytes := 0, 0, 0, 0, 0
	documentHashes := make([]any, 0, len(documents))
	type entryTarget struct{ id, path string }
	var entryTargets []entryTarget
	for ordinal, doc := range documents {
		if doc.Ordinal != ordinal || (ordinal > 0 && doc.Path <= previous) || ids[doc.ID] || paths[doc.Path] {
			return loadFail(ErrDocumentInvalid, doc.Path, "document identity/order mismatch")
		}
		previous, ids[doc.ID], paths[doc.Path] = doc.Path, true, true
		documentsByID[doc.ID] = doc
		sourceBytes += doc.Source.Bytes
		rawSource, err := base64.StdEncoding.DecodeString(doc.Source.ContentBase64)
		if err != nil || len(rawSource) != doc.Source.Bytes || digest(rawSource) != doc.Source.SHA256 || doc.Source.Ref != m.SourceBaseline.Ref || doc.Source.Commit != m.SourceBaseline.Commit {
			return loadFail(ErrDocumentInvalid, doc.Path, "source binding mismatch")
		}
		var projection any
		if err := decodeUseNumber(doc.Projection, &projection); err != nil || digestCompact(projection) != doc.Verification.ProjectionSHA256 {
			return loadFail(ErrDocumentInvalid, doc.Path, "projection hash mismatch")
		}
		projectionMap, ok := projection.(map[string]any)
		if !ok || projectionMap["id"] != doc.ID || projectionMap["kind"] != doc.Kind || projectionMap["path"] != doc.Path || projectionMap["slug"] != doc.Slug {
			return loadFail(ErrDocumentInvalid, doc.Path, "projection envelope mismatch")
		}
		docMap, ok := generic[ordinal].(map[string]any)
		if !ok {
			return loadFail(ErrDocumentInvalid, doc.Path, "document encoding mismatch")
		}
		verification, ok := docMap["verification"].(map[string]any)
		if !ok {
			return loadFail(ErrDocumentInvalid, doc.Path, "document verification missing")
		}
		verification["document_sha256"] = nil
		if digestCompact(docMap) != doc.Verification.DocumentSHA256 {
			return loadFail(ErrDocumentInvalid, doc.Path, "document self-hash mismatch")
		}
		documentHashes = append(documentHashes, doc.Verification.DocumentSHA256)
		switch doc.Kind {
		case "lead-sheet":
			leadSheets++
			leadIDs[doc.ID] = true
			if doc.Apex == nil || doc.Apex.SourceSHA256 != doc.Source.SHA256 || len([]byte(doc.Apex.HTML)) != doc.Apex.Bytes || digest([]byte(doc.Apex.HTML)) != doc.Apex.SHA256 {
				return loadFail(ErrDocumentInvalid, doc.Path, "Apex binding mismatch")
			}
			if doc.Fit == nil || doc.Fit.SourceSHA256 != doc.Source.SHA256 || len(doc.Fit.Profiles) != 3 {
				return loadFail(ErrDocumentInvalid, doc.Path, "fit binding mismatch")
			}
			profiles := map[string]bool{}
			for _, fit := range doc.Fit.Profiles {
				lineHeight, lineHeightErr := fit.LineHeight.Float64()
				if profiles[fit.Profile] || (fit.Profile != "ipad-portrait" && fit.Profile != "ipad-landscape" && fit.Profile != "phone") || (fit.Status != "fit" && fit.Status != "needs-editing" && fit.Status != "scrollable") || (fit.Profile == "phone" && fit.Status != "scrollable") || (fit.Profile != "phone" && fit.Status == "scrollable") || fit.BodyPX <= 0 || fit.AutoBodyPX <= 0 || fit.ColumnCount < 1 || fit.ColumnCount != len(fit.Columns) || lineHeightErr != nil || lineHeight <= 0 {
					return loadFail(ErrDocumentInvalid, doc.Path, "fit result is outside the frozen schema")
				}
				profiles[fit.Profile] = true
			}
			if !profiles["ipad-portrait"] || !profiles["ipad-landscape"] || !profiles["phone"] || len(profiles) != 3 {
				return loadFail(ErrDocumentInvalid, doc.Path, "fit profile coverage mismatch")
			}
		case "set-list":
			setLists++
			if doc.Apex != nil || doc.Fit != nil {
				return loadFail(ErrDocumentInvalid, doc.Path, "Set List render must be null")
			}
			sectionValues, ok1 := projectionMap["sections"].([]any)
			entryValues, ok2 := projectionMap["entries"].([]any)
			if !ok1 || !ok2 {
				return loadFail(ErrDocumentInvalid, doc.Path, "Set List projection missing sections or entries")
			}
			sections += len(sectionValues)
			entries += len(entryValues)
			localEntryIDs := map[string]bool{}
			for index, value := range entryValues {
				entry, ok := value.(map[string]any)
				if !ok {
					return loadFail(ErrDocumentInvalid, doc.Path, "Set Entry malformed")
				}
				id, okID := entry["id"].(string)
				targetID, okTargetID := entry["targetLeadSheetId"].(string)
				targetPath, okTargetPath := entry["targetPath"].(string)
				setID, okSetID := entry["setId"].(string)
				if !okID || !okTargetID || !okTargetPath || !okSetID || setID != doc.ID || fmt.Sprint(entry["ordinal"]) != fmt.Sprint(index+1) || entryIDs[id] {
					return loadFail(ErrDocumentInvalid, doc.Path, "duplicate or malformed Set Entry")
				}
				entryIDs[id], localEntryIDs[id] = true, true
				entryTargets = append(entryTargets, entryTarget{id: targetID, path: targetPath})
			}
			sectionEntryIDs := map[string]bool{}
			sectionEntryCount := 0
			for index, value := range sectionValues {
				section, ok := value.(map[string]any)
				if !ok || section["identityScope"] != "frozen-snapshot" || section["setId"] != doc.ID || fmt.Sprint(section["ordinal"]) != fmt.Sprint(index+1) {
					return loadFail(ErrDocumentInvalid, doc.Path, "Set section identity mismatch")
				}
				sectionIDs, ok := section["entryIds"].([]any)
				if !ok {
					return loadFail(ErrDocumentInvalid, doc.Path, "Set section entries missing")
				}
				for _, value := range sectionIDs {
					id, ok := value.(string)
					if !ok || !localEntryIDs[id] || sectionEntryIDs[id] {
						return loadFail(ErrDocumentInvalid, doc.Path, "Set sections do not cover entries exactly once")
					}
					sectionEntryIDs[id] = true
					sectionEntryCount++
				}
			}
			if sectionEntryCount != len(localEntryIDs) {
				return loadFail(ErrDocumentInvalid, doc.Path, "Set sections do not cover entries exactly once")
			}
		default:
			return loadFail(ErrDocumentInvalid, doc.Path, "unsupported document kind")
		}
	}
	for _, target := range entryTargets {
		document, ok := documentsByID[target.id]
		if !ok || document.Kind != "lead-sheet" || document.Path != target.path || !leadIDs[target.id] {
			return loadFail(ErrDocumentInvalid, target.id, "Set Entry target missing or mismatched")
		}
	}
	actualCounts := counts{len(documents), leadSheets, setLists, sections, entries, sourceBytes}
	if actualCounts != m.Counts {
		return loadFail(ErrSnapshotInvalid, "data/manifest.json", "manifest counts mismatch")
	}
	if len(m.SlugRoutes) != len(documents) {
		return loadFail(ErrSnapshotInvalid, "data/manifest.json", "slug route coverage mismatch")
	}
	routeKeys := map[string]bool{}
	for _, route := range m.SlugRoutes {
		key := route.Kind + ":" + route.Slug
		document, ok := documentsByID[route.DocumentID]
		expectedKind := "set"
		if ok && document.Kind == "lead-sheet" {
			expectedKind = "song"
		}
		if routeKeys[key] || !ok || route.Kind != expectedKind || route.Slug != document.Slug || route.Path != document.Path {
			return loadFail(ErrSnapshotInvalid, route.Path, "slug route mismatch")
		}
		routeKeys[key] = true
	}
	routes := make([]any, 0, len(m.SlugRoutes))
	for _, route := range m.SlugRoutes {
		routes = append(routes, map[string]any{"kind": route.Kind, "slug": route.Slug, "path": route.Path, "documentId": route.DocumentID})
	}
	logical := map[string]any{
		"source_baseline":   map[string]any{"ref": m.SourceBaseline.Ref, "tag_object": m.SourceBaseline.TagObject, "commit": m.SourceBaseline.Commit},
		"evidence_baseline": map[string]any{"ref": m.EvidenceBaseline.Ref, "tag_object": m.EvidenceBaseline.TagObject, "commit": m.EvidenceBaseline.Commit},
		"read_model_anchor": map[string]any{"implementation_commit": m.ReadModelAnchor.ImplementationCommit, "import_report_file_sha256": m.ReadModelAnchor.ImportReportFileSHA256, "import_report_output_sha256": m.ReadModelAnchor.ImportReportOutputSHA256},
		"contract_hashes":   m.ContractHashes,
		"evidence_hashes":   m.EvidenceHashes,
		"apex":              m.Apex, "physical_ipad": m.PhysicalIPad, "slug_routes": routes,
		"document_hashes": documentHashes,
	}
	snapshot := digestCompact(logical)
	if snapshot != m.SnapshotSHA256 || m.Generation != "phase1-"+snapshot[:24] {
		return loadFail(ErrSnapshotInvalid, "data/manifest.json", fmt.Sprintf("snapshot generation mismatch: got %s want %s", snapshot, m.SnapshotSHA256))
	}
	return nil
}

func strictDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func decodeUseNumber(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func rejectDuplicateKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeJSON(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func canonicalObjectKey(key string) bool {
	if key == "" || !((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= 'a' && key[0] <= 'z') || key[0] == '_') {
		return false
	}
	for index := 1; index < len(key); index++ {
		character := key[index]
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

func consumeJSON(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		if number, numeric := token.(json.Number); numeric {
			text := number.String()
			parsed, parseErr := strconv.ParseFloat(text, 64)
			fractionalDigits := 0
			if dot := strings.IndexByte(text, '.'); dot >= 0 {
				fractionalDigits = len(text) - dot - 1
			}
			integer := math.Trunc(parsed) == parsed
			outsideDomain := integer && math.Abs(parsed) > 9007199254740991 || !integer && (math.Abs(parsed) >= 1_000_000 || fractionalDigits < 1 || fractionalDigits > 6)
			if parseErr != nil || strings.ContainsAny(text, "eE") || text == "-0" || outsideDomain || strconv.FormatFloat(parsed, 'f', -1, 64) != text {
				return fmt.Errorf("noncanonical JSON number %q", text)
			}
		}
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			if seen[key] {
				return fmt.Errorf("duplicate JSON key %q", key)
			}
			if !canonicalObjectKey(key) {
				return fmt.Errorf("JSON object key %q is outside the canonical domain", key)
			}
			seen[key] = true
			if err := consumeJSON(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if err := consumeJSON(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("unterminated JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func normalizeJavaScriptSeparators(raw []byte) []byte {
	output := make([]byte, 0, len(raw))
	for index := 0; index < len(raw); index++ {
		if index+6 <= len(raw) && raw[index] == '\\' && (string(raw[index:index+6]) == `\u2028` || string(raw[index:index+6]) == `\u2029`) {
			backslashes := 0
			for previous := index - 1; previous >= 0 && raw[previous] == '\\'; previous-- {
				backslashes++
			}
			if backslashes%2 == 0 {
				if raw[index+5] == '8' {
					output = append(output, []byte("\u2028")...)
				} else {
					output = append(output, []byte("\u2029")...)
				}
				index += 5
				continue
			}
		}
		output = append(output, raw[index])
	}
	return output
}

func requireCanonicalJSON(raw []byte) error {
	var value any
	if err := decodeUseNumber(raw, &value); err != nil {
		return err
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}
	canonical := normalizeJavaScriptSeparators(output.Bytes())
	if !bytes.Equal(raw, canonical) {
		return errors.New("JSON is not in canonical sorted form")
	}
	return nil
}

func nullHash(raw []byte, parent, field string) (string, error) {
	var value map[string]any
	if err := decodeUseNumber(raw, &value); err != nil {
		return "", err
	}
	container, ok := value[parent].(map[string]any)
	if !ok {
		return "", errors.New("hash container missing")
	}
	container[field] = nil
	return digestCompact(value), nil
}

func digest(raw []byte) string       { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func digestCompact(value any) string { raw, _ := compact(value); return digest(raw) }
func compact(value any) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return normalizeJavaScriptSeparators(bytes.TrimSuffix(output.Bytes(), []byte("\n"))), nil
}
func framedDigest(parts []string) string {
	hash := sha256.New()
	var length [8]byte
	for _, part := range parts {
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		hash.Write(length[:])
		hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func (s *Snapshot) Generation() string    { return s.generation }
func (s *Snapshot) ManifestBytes() []byte { return bytes.Clone(s.manifest) }
func (s *Snapshot) ChunkBytes(name string) ([]byte, bool) {
	raw, ok := s.chunks[name]
	return bytes.Clone(raw), ok
}
func (s *Snapshot) ManifestSHA256() string { return strings.Trim(s.manifestETag, "\"") }
func (s *Snapshot) Handler() http.Handler  { return &apiHandler{snapshot: s} }
