package v2bootstrap

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"testing/fstest"
)

func embeddedFiles(t *testing.T) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	err := fs.WalkDir(embedded, "data", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := fs.ReadFile(embedded, path)
		if err != nil {
			return err
		}
		files[path] = &fstest.MapFile{Data: bytes.Clone(raw), Mode: 0o444}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func decodeMap(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var value map[string]any
	if err := decodeUseNumber(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func encodePretty(t *testing.T, value any) []byte {
	t.Helper()
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func resign(t *testing.T, value map[string]any, field string) []byte {
	t.Helper()
	verification := value["verification"].(map[string]any)
	verification[field] = nil
	raw, err := compact(value)
	if err != nil {
		t.Fatal(err)
	}
	verification[field] = digest(raw)
	return encodePretty(t, value)
}

func loadCode(t *testing.T, files fs.FS, code ErrorCode) {
	t.Helper()
	_, err := Load(files)
	var loadErr *LoadError
	if !errors.As(err, &loadErr) || loadErr.Code != code {
		t.Fatalf("error=%v, want code %s", err, code)
	}
}

func TestLoadEmbeddedSnapshot(t *testing.T) {
	snapshot, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Generation() != expectedGeneration {
		t.Fatalf("generation=%s", snapshot.Generation())
	}
	if len(snapshot.chunks) != 12 || len(snapshot.manifest) == 0 {
		t.Fatalf("snapshot sizes manifest=%d chunks=%d", len(snapshot.manifest), len(snapshot.chunks))
	}
}

func TestLoaderRejectsMissingUnexpectedCorruptReorderedAndUnsupportedAssets(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		files := embeddedFiles(t)
		delete(files, "data/chunks/chunk-000.json")
		loadCode(t, files, ErrChunkMissing)
	})
	t.Run("unexpected", func(t *testing.T) {
		files := embeddedFiles(t)
		files["data/chunks/chunk-999.json"] = &fstest.MapFile{Data: []byte("{}\n")}
		loadCode(t, files, ErrChunkUnexpected)
	})
	t.Run("corrupt", func(t *testing.T) {
		files := embeddedFiles(t)
		raw := bytes.Clone(files["data/chunks/chunk-000.json"].Data)
		raw[len(raw)/2] ^= 1
		files["data/chunks/chunk-000.json"].Data = raw
		loadCode(t, files, ErrChunkHash)
	})
	t.Run("reordered", func(t *testing.T) {
		files := embeddedFiles(t)
		value := decodeMap(t, files["data/manifest.json"].Data)
		chunks := value["chunks"].([]any)
		chunks[0].(map[string]any)["index"] = json.Number("1")
		files["data/manifest.json"].Data = resign(t, value, "output_sha256")
		loadCode(t, files, ErrManifestInvalid)
	})
	t.Run("manifest schema", func(t *testing.T) {
		files := embeddedFiles(t)
		value := decodeMap(t, files["data/manifest.json"].Data)
		value["schema_version"] = "2"
		files["data/manifest.json"].Data = encodePretty(t, value)
		loadCode(t, files, ErrManifestInvalid)
	})
	t.Run("chunk schema", func(t *testing.T) {
		files := embeddedFiles(t)
		chunkPath := "data/chunks/chunk-000.json"
		chunkValue := decodeMap(t, files[chunkPath].Data)
		chunkValue["schema_version"] = "2"
		chunkRaw := resign(t, chunkValue, "output_sha256")
		files[chunkPath].Data = chunkRaw
		manifestValue := decodeMap(t, files["data/manifest.json"].Data)
		descriptor := manifestValue["chunks"].([]any)[0].(map[string]any)
		descriptor["sha256"] = digest(chunkRaw)
		descriptor["bytes"] = json.Number(fmt.Sprint(len(chunkRaw)))
		files["data/manifest.json"].Data = resign(t, manifestValue, "output_sha256")
		loadCode(t, files, ErrManifestInvalid)
	})
}

func TestCanonicalJSONRejectsDuplicateKeysAndAlternateNumberSpellings(t *testing.T) {
	if err := rejectDuplicateKeys([]byte("{\n  \"line_height\": 124e-2\n}\n")); err == nil {
		t.Fatal("alternate numeric spelling accepted")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"line_height\": 1.00000000000000001\n}\n")); err == nil {
		t.Fatal("precision-rounding numeric spelling accepted")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"line_height\": 0.000001\n}\n")); err != nil {
		t.Fatalf("canonical decimal boundary rejected: %v", err)
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"line_height\": 0.0000001\n}\n")); err == nil {
		t.Fatal("exponent-producing small decimal accepted")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"line_height\": 1000000000000000000000\n}\n")); err == nil {
		t.Fatal("unsafe exponent-producing integer accepted")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"2\": \"two\",\n  \"10\": \"ten\"\n}\n")); err == nil {
		t.Fatal("integer-like object key accepted")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"𐀀\": \"astral\",\n  \"\": \"bmp\"\n}\n")); err == nil {
		t.Fatal("non-ASCII object key accepted")
	}
	if err := requireCanonicalJSON([]byte("{\n  \"x\": \" \"\n}\n")); err != nil {
		t.Fatalf("literal U+2028 rejected: %v", err)
	}
	if err := requireCanonicalJSON([]byte(`{
  "x": "\u2028"
}
`)); err == nil {
		t.Fatal("escaped U+2028 accepted as canonical")
	}
	if err := requireCanonicalJSON([]byte(`{
  "x": "\ud800"
}
`)); err == nil {
		t.Fatal("lone surrogate accepted as canonical")
	}
	if err := rejectDuplicateKeys([]byte("{\n  \"title\": \"first\",\n  \"title\": \"second\"\n}\n")); err == nil {
		t.Fatal("duplicate key accepted")
	}
	if err := requireCanonicalJSON([]byte("{\n  \"line_height\": 1.24\n}\n")); err != nil {
		t.Fatalf("canonical JSON rejected: %v", err)
	}
}

func TestLoaderRejectsDuplicateKeysAndResignedSourceCorruption(t *testing.T) {
	t.Run("duplicate key", func(t *testing.T) {
		files := embeddedFiles(t)
		raw := files["data/manifest.json"].Data
		files["data/manifest.json"].Data = bytes.Replace(raw, []byte(`"schema_version": "1",`), []byte(`"schema_version": "1", "schema_version": "1",`), 1)
		loadCode(t, files, ErrManifestInvalid)
	})
	t.Run("source corruption", func(t *testing.T) {
		files := embeddedFiles(t)
		chunkPath := "data/chunks/chunk-000.json"
		chunkValue := decodeMap(t, files[chunkPath].Data)
		documents := chunkValue["documents"].([]any)
		source := documents[0].(map[string]any)["source"].(map[string]any)
		source["content_base64"] = "AA=="
		chunkRaw := resign(t, chunkValue, "output_sha256")
		files[chunkPath].Data = chunkRaw
		manifestValue := decodeMap(t, files["data/manifest.json"].Data)
		descriptor := manifestValue["chunks"].([]any)[0].(map[string]any)
		descriptor["sha256"] = digest(chunkRaw)
		descriptor["bytes"] = json.Number(fmt.Sprint(len(chunkRaw)))
		files["data/manifest.json"].Data = resign(t, manifestValue, "output_sha256")
		loadCode(t, files, ErrManifestInvalid)
	})
}

type countingFS struct {
	fs.FS
	mu    sync.Mutex
	reads int
}

func (c *countingFS) Open(name string) (fs.File, error) {
	c.mu.Lock()
	c.reads++
	c.mu.Unlock()
	return c.FS.Open(name)
}
func (c *countingFS) count() int { c.mu.Lock(); defer c.mu.Unlock(); return c.reads }

func TestHandlerUsesOnlyLoadedImmutableBytesAndReturnsJSONErrors(t *testing.T) {
	files := &countingFS{FS: embeddedFiles(t)}
	snapshot, err := Load(files)
	if err != nil {
		t.Fatal(err)
	}
	readsAfterLoad := files.count()
	handler := snapshot.Handler()

	request := func(method, path, user string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if user != "" {
			req.Header.Set("X-ExeDev-UserID", user)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	unauth := request(http.MethodGet, "/api/v2/bootstrap/manifest", "")
	if unauth.Code != http.StatusUnauthorized || unauth.Header().Get("Content-Type") != "application/json; charset=utf-8" || bytes.Contains(unauth.Body.Bytes(), []byte("<html")) {
		t.Fatalf("unauth response=%d %s", unauth.Code, unauth.Body.String())
	}
	manifestResponse := request(http.MethodGet, "/api/v2/bootstrap/manifest", "user-1")
	if manifestResponse.Code != http.StatusOK || !bytes.Equal(manifestResponse.Body.Bytes(), snapshot.manifest) {
		t.Fatalf("manifest response mismatch")
	}
	chunkResponse := request(http.MethodGet, "/api/v2/bootstrap/"+snapshot.generation+"/chunks/chunk-000.json", "user-1")
	if chunkResponse.Code != http.StatusOK || !bytes.Equal(chunkResponse.Body.Bytes(), snapshot.chunks["chunk-000.json"]) {
		t.Fatalf("chunk response mismatch")
	}
	for _, response := range []*httptest.ResponseRecorder{
		request(http.MethodPost, "/api/v2/bootstrap/manifest", "user-1"),
		request(http.MethodGet, "/api/v2/bootstrap/wrong/chunks/chunk-000.json", "user-1"),
		request(http.MethodGet, "/api/v2/unknown", "user-1"),
	} {
		if response.Header().Get("Content-Type") != "application/json; charset=utf-8" || bytes.Contains(response.Body.Bytes(), []byte("<html")) {
			t.Fatalf("non-JSON API failure: %d %s", response.Code, response.Body.String())
		}
	}
	if files.count() != readsAfterLoad {
		t.Fatalf("handler performed filesystem reads: before=%d after=%d", readsAfterLoad, files.count())
	}
}
