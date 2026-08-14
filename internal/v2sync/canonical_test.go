package v2sync

import (
	"bytes"
	"strings"
	"testing"
)

func TestCanonicalJSONAndHashContract(t *testing.T) {
	variants := [][]byte{
		[]byte(`{"a":1,"array":[true,null,"x"],"nested":{"a":1,"b":2},"z":0.25}`),
		[]byte(" { \"z\" : 0.25, \"nested\" : {\"b\":2,\"a\":1}, \"array\" : [true,null,\"x\"], \"a\":1 } \n"),
	}
	var wantHash string
	var wantCanonical []byte
	for i, raw := range variants {
		hash, canonical, err := HashPayload(raw)
		if err != nil {
			t.Fatalf("variant %d: %v", i, err)
		}
		if i == 0 {
			wantHash, wantCanonical = hash, canonical
			continue
		}
		if hash != wantHash || !bytes.Equal(canonical, wantCanonical) {
			t.Fatalf("equivalent JSON canonicalized differently:\n%x %s\n%x %s", wantHash, wantCanonical, hash, canonical)
		}
	}
	if got, want := string(wantCanonical), `{"a":1,"array":[true,null,"x"],"nested":{"a":1,"b":2},"z":0.25}`; got != want {
		t.Fatalf("canonical JSON = %s, want %s", got, want)
	}
	if wantHash != sha256Hex(wantCanonical) {
		t.Fatalf("hash %q is not over canonical bytes %q", wantHash, wantCanonical)
	}
}

func TestCanonicalJSONRejectsDuplicateKeysAtEveryDepth(t *testing.T) {
	cases := map[string]string{
		"top level":       `{"a":1,"a":2}`,
		"nested object":   `{"outer":{"a":1,"a":2}}`,
		"object in array": `[{"a":1,"a":2}]`,
		"escaped equal":   `{"a":1,"\u0061":2}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := HashPayload([]byte(raw)); err == nil {
				t.Fatalf("duplicate-key JSON accepted: %s", raw)
			} else {
				requireCode(t, err, "INVALID_PAYLOAD")
			}
		})
	}
}

func TestCanonicalJSONRejectsTrailingValuesAndGarbage(t *testing.T) {
	cases := []string{
		`{"a":1}{"b":2}`,
		`{"a":1} null`,
		`[1] true`,
		`{"a":1} trailing`,
		``,
		`   `,
	}
	for _, raw := range cases {
		t.Run(strings.ReplaceAll(raw, " ", "_"), func(t *testing.T) {
			if _, _, err := HashPayload([]byte(raw)); err == nil {
				t.Fatalf("trailing/empty JSON accepted: %q", raw)
			} else {
				requireCode(t, err, "INVALID_PAYLOAD")
			}
		})
	}
}

func TestCanonicalJSONNumberDomain(t *testing.T) {
	accepted := []string{
		`0`, `1`, `-1`, `9007199254740991`, `-9007199254740991`,
		`0.1`, `-0.1`, `999999.999999`, `-999999.999999`, `1.000001`,
	}
	for _, raw := range accepted {
		t.Run("accept_"+strings.ReplaceAll(raw, ".", "_"), func(t *testing.T) {
			hash, canonical, err := HashPayload([]byte(raw))
			if err != nil {
				t.Fatalf("canonical number %q rejected: %v", raw, err)
			}
			if string(canonical) != raw || hash != sha256Hex([]byte(raw)) {
				t.Fatalf("number %q canonicalized/hash as %q/%q", raw, canonical, hash)
			}
		})
	}

	rejected := []string{
		`-0`, `01`, `1.`, `.1`, `1e0`, `1E+2`,
		`9007199254740992`, `-9007199254740992`,
		`1000000.1`, `-1000000.1`, `0.0000001`, `1.0000000`,
		`NaN`, `Infinity`, `-Infinity`,
	}
	for _, raw := range rejected {
		t.Run("reject_"+strings.NewReplacer(".", "_", "+", "plus", "-", "minus").Replace(raw), func(t *testing.T) {
			if _, _, err := HashPayload([]byte(raw)); err == nil {
				t.Fatalf("noncanonical/out-of-domain number accepted: %q", raw)
			} else {
				requireCode(t, err, "INVALID_PAYLOAD")
			}
		})
	}
}

func TestCanonicalJSONRejectsInvalidEncodingNULAndOversize(t *testing.T) {
	cases := map[string][]byte{
		"invalid UTF-8": {0xff},
		"literal NUL":   []byte("{\"x\":\"\x00\"}"),
		"escaped NUL":   []byte(`{"x":"\u0000"}`),
		"NUL key":       []byte(`{"\u0000":1}`),
		"oversize":      append([]byte(`"`), append(bytes.Repeat([]byte{'a'}, 1<<20), '"')...),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := HashPayload(raw); err == nil {
				t.Fatalf("invalid JSON payload accepted (%d bytes)", len(raw))
			} else {
				requireCode(t, err, "INVALID_PAYLOAD")
			}
		})
	}
}

func TestApplyRequiresHashOfCanonicalPayload(t *testing.T) {
	store, _ := openTestStore(t)
	registerTestDevice(t, store, testOwner, "device-a", "registration-a", testToken)
	raw := []byte(`{ "b": 2, "a": 1 }`)
	envelope := testApplyEnvelope(t, testOwner, "device-a", "operation-a", "document-a", "", "A", string(raw), 0)
	envelope.PayloadSHA256 = sha256Hex(raw)
	if _, err := store.Apply(envelope); err == nil {
		t.Fatal("hash of noncanonical wire bytes was accepted")
	} else {
		requireCode(t, err, "PAYLOAD_HASH_MISMATCH")
	}
	hash, canonical, err := HashPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	envelope.PayloadSHA256 = hash
	outcome, err := store.Apply(envelope)
	if err != nil {
		t.Fatal(err)
	}
	revision, err := store.Revision(testOwner, "device-a", outcome.RevisionID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(revision.Payload, canonical) || revision.ContentHash != hash {
		t.Fatalf("durable payload/hash = %s/%s, want %s/%s", revision.Payload, revision.ContentHash, canonical, hash)
	}
}
