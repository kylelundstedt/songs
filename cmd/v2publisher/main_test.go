package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"songs.exe.dev/internal/v2publish"
	"songs.exe.dev/internal/v2sync"
)

type recordingAPI struct {
	publishCalls   int
	reconcileCalls int
	bootstrapCalls int
	got            apiConfig
	err            error
}

func (a *recordingAPI) PublishOnce(_ context.Context, cfg apiConfig) error {
	a.publishCalls++
	a.got = cfg
	return a.err
}

func (a *recordingAPI) BootstrapOnce(_ context.Context, cfg apiConfig) error {
	a.bootstrapCalls++
	a.got = cfg
	return a.err
}

func (a *recordingAPI) ReconcileOnce(_ context.Context, cfg apiConfig) error {
	a.reconcileCalls++
	a.got = cfg
	return a.err
}

func completeArgs(mode string) []string {
	args := []string{
		"-enabled",
		"-mode=" + mode,
		"-ledger=publication-ledger",
		"-sync=sync-ledger",
		"-repository=repository",
		"-work-root=publisher-work",
		"-owner=owner-main",
		"-device=publisher-1",
		"-holder=worker-1",
		"-apex=apex-validator",
		"-lock=publisher-lock",
	}
	if mode == modePublish {
		args = append(args, "-document=document-1", "-revision=rev-0123456789abcdef01234567")
	}
	return args
}

func completeConfig(mode string) config {
	result := config{
		enabled: true,
		mode:    mode,
		api: apiConfig{
			Ledger:     "publication-ledger",
			Sync:       "sync-ledger",
			Repository: "repository",
			WorkRoot:   "publisher-work",
			Owner:      "owner-main",
			Device:     "publisher-1",
			Holder:     "worker-1",
			Apex:       "apex-validator",
			Lock:       "publisher-lock",
		},
	}
	if mode == modePublish {
		result.api.Document = "document-1"
		result.api.Revision = "rev-0123456789abcdef01234567"
	}
	return result
}

func TestExplicitPublicationBranchIsPassedToAdapter(t *testing.T) {
	api := &recordingAPI{}
	args := append(completeArgs(modeBootstrap), "-branch=refs/heads/v2-published")
	if err := run(context.Background(), args, &bytes.Buffer{}, api); err != nil {
		t.Fatal(err)
	}
	if api.bootstrapCalls != 1 || api.got.Branch != "refs/heads/v2-published" {
		t.Fatalf("bootstrap branch = %q, calls = %d", api.got.Branch, api.bootstrapCalls)
	}
}

func TestDefaultsAreDisabledAndUnconfigured(t *testing.T) {
	cfg, err := parseConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.enabled {
		t.Fatal("publisher is enabled by default")
	}
	if cfg.mode != "" || cfg.api != (apiConfig{}) {
		t.Fatalf("default configuration = %+v, want empty", cfg)
	}
	if err := validateConfig(cfg); err != nil {
		t.Fatalf("disabled empty defaults rejected: %v", err)
	}
}

func TestDefaultRunDoesNotInvokeAPIOrTouchFilesystem(t *testing.T) {
	temp := t.TempDir()
	before, err := os.ReadDir(temp)
	if err != nil {
		t.Fatal(err)
	}
	api := &recordingAPI{err: errors.New("must not be called")}
	var stdout bytes.Buffer
	if err := run(context.Background(), nil, &stdout, api); err != nil {
		t.Fatalf("default run: %v", err)
	}
	if api.publishCalls != 0 || api.reconcileCalls != 0 || api.bootstrapCalls != 0 {
		t.Fatalf("default run invoked API: %+v", api)
	}
	after, err := os.ReadDir(temp)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("default run changed filesystem: before=%v after=%v", before, after)
	}
	if got := stdout.String(); !strings.Contains(got, "disabled") || !strings.Contains(got, "no publication, reconciliation, or bootstrap attempted") {
		t.Fatalf("default output = %q, want explicit disabled notice", got)
	}
}

func TestDisabledRunRejectsEveryConfigurationField(t *testing.T) {
	fields := []string{
		"-mode=publish",
		"-ledger=publication-ledger",
		"-sync=sync-ledger",
		"-repository=repository",
		"-owner=owner-main",
		"-device=publisher-1",
		"-apex=apex-validator",
		"-lock=publisher-lock",
	}
	for _, field := range fields {
		t.Run(strings.TrimPrefix(strings.SplitN(field, "=", 2)[0], "-"), func(t *testing.T) {
			api := &recordingAPI{}
			err := run(context.Background(), []string{field}, &bytes.Buffer{}, api)
			if err == nil || !strings.Contains(err.Error(), "without -enabled") {
				t.Fatalf("run(%q) error = %v, want disabled configuration rejection", field, err)
			}
			if api.publishCalls != 0 || api.reconcileCalls != 0 || api.bootstrapCalls != 0 {
				t.Fatalf("rejected configuration invoked API: %+v", api)
			}
		})
	}

	api := &recordingAPI{}
	args := completeArgs(modePublish)[1:] // complete operational config, no enable gate
	if err := run(context.Background(), args, &bytes.Buffer{}, api); err == nil || !strings.Contains(err.Error(), "without -enabled") {
		t.Fatalf("complete disabled configuration error = %v, want rejection", err)
	}
	if api.publishCalls != 0 || api.reconcileCalls != 0 || api.bootstrapCalls != 0 {
		t.Fatalf("complete disabled configuration invoked API: %+v", api)
	}
}

func TestEnabledRunRequiresModeAndAllOperationalConfiguration(t *testing.T) {
	full := completeConfig(modePublish)
	cases := []struct {
		name   string
		mutate func(*config)
		want   string
	}{
		{"mode", func(c *config) { c.mode = "" }, "-mode"},
		{"ledger", func(c *config) { c.api.Ledger = "" }, "-ledger"},
		{"sync", func(c *config) { c.api.Sync = "" }, "-sync"},
		{"repository", func(c *config) { c.api.Repository = "" }, "-repository"},
		{"owner", func(c *config) { c.api.Owner = "" }, "-owner"},
		{"device", func(c *config) { c.api.Device = "" }, "-device"},
		{"apex", func(c *config) { c.api.Apex = "" }, "-apex"},
		{"lock", func(c *config) { c.api.Lock = "" }, "-lock"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := full
			tc.mutate(&cfg)
			err := validateConfig(cfg)
			if err == nil || !strings.Contains(err.Error(), "missing: ") || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("validateConfig error = %v, want missing %s", err, tc.want)
			}
		})
	}

	cfg := config{enabled: true}
	err := validateConfig(cfg)
	for _, want := range []string{"-mode", "-ledger", "-sync", "-repository", "-owner", "-device", "-apex", "-lock"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("empty enabled configuration error = %v, want %s", err, want)
		}
	}
}

func TestConfigurationRejectsWhitespaceAndUnknownModes(t *testing.T) {
	for _, mode := range []string{"", "once", "publication", "reconciliation", "Publish", "publish,reconcile"} {
		if mode == "" {
			continue // covered as a missing required value above
		}
		t.Run("mode "+mode, func(t *testing.T) {
			cfg := completeConfig(mode)
			err := validateConfig(cfg)
			if err == nil || !strings.Contains(err.Error(), "invalid -mode") {
				t.Fatalf("validateConfig(%q) error = %v, want invalid mode", mode, err)
			}
		})
	}

	fields := []struct {
		name   string
		mutate func(*config)
	}{
		{"mode", func(c *config) { c.mode = " publish" }},
		{"ledger", func(c *config) { c.api.Ledger += " " }},
		{"sync", func(c *config) { c.api.Sync = " " + c.api.Sync }},
		{"repository", func(c *config) { c.api.Repository += "\n" }},
		{"owner", func(c *config) { c.api.Owner = " " + c.api.Owner }},
		{"device", func(c *config) { c.api.Device += "\t" }},
		{"apex", func(c *config) { c.api.Apex = " " + c.api.Apex }},
		{"lock", func(c *config) { c.api.Lock += " " }},
	}
	for _, tc := range fields {
		t.Run("whitespace "+tc.name, func(t *testing.T) {
			cfg := completeConfig(modePublish)
			tc.mutate(&cfg)
			if err := validateConfig(cfg); err == nil {
				t.Fatal("whitespace-padded configuration was accepted")
			}
		})
	}
}

func TestPublishModeInvokesExactlyOnePublication(t *testing.T) {
	api := &recordingAPI{}
	var stdout bytes.Buffer
	if err := run(context.Background(), completeArgs(modePublish), &stdout, api); err != nil {
		t.Fatal(err)
	}
	if api.publishCalls != 1 || api.reconcileCalls != 0 {
		t.Fatalf("calls = publish %d, reconcile %d; want 1, 0", api.publishCalls, api.reconcileCalls)
	}
	if want := completeConfig(modePublish).api; api.got != want {
		t.Fatalf("API config = %+v, want %+v", api.got, want)
	}
	if stdout.String() != "v2publisher publish completed\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestReconcileModeInvokesExactlyOneReconciliation(t *testing.T) {
	api := &recordingAPI{}
	var stdout bytes.Buffer
	if err := run(context.Background(), completeArgs(modeReconcile), &stdout, api); err != nil {
		t.Fatal(err)
	}
	if api.publishCalls != 0 || api.reconcileCalls != 1 {
		t.Fatalf("calls = publish %d, reconcile %d; want 0, 1", api.publishCalls, api.reconcileCalls)
	}
	if want := completeConfig(modeReconcile).api; api.got != want {
		t.Fatalf("API config = %+v, want %+v", api.got, want)
	}
	if stdout.String() != "v2publisher reconcile completed\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestBootstrapModeInvokesExactlyOneBootstrap(t *testing.T) {
	api := &recordingAPI{}
	var stdout bytes.Buffer
	if err := run(context.Background(), completeArgs(modeBootstrap), &stdout, api); err != nil {
		t.Fatal(err)
	}
	if api.bootstrapCalls != 1 || api.publishCalls != 0 || api.reconcileCalls != 0 {
		t.Fatalf("calls = %+v", api)
	}
	if want := completeConfig(modeBootstrap).api; api.got != want {
		t.Fatalf("API config = %+v, want %+v", api.got, want)
	}
	if stdout.String() != "v2publisher bootstrap completed\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestOperationFailureIsReturnedWithoutRetry(t *testing.T) {
	cause := errors.New("fence lost")
	api := &recordingAPI{err: cause}
	err := run(context.Background(), completeArgs(modePublish), &bytes.Buffer{}, api)
	if !errors.Is(err, cause) {
		t.Fatalf("run error = %v, want wrapped operation error", err)
	}
	if api.publishCalls != 1 || api.reconcileCalls != 0 {
		t.Fatalf("failed operation was retried or misrouted: %+v", api)
	}
}

func TestUnavailableAdapterFailsClosedWithoutFilesystemEffects(t *testing.T) {
	temp := t.TempDir()
	paths := struct {
		ledger, sync, repository, apex, lock string
	}{
		filepath.Join(temp, "ledger.db"),
		filepath.Join(temp, "sync.db"),
		filepath.Join(temp, "repository"),
		filepath.Join(temp, "apex"),
		filepath.Join(temp, "publisher.lock"),
	}
	args := []string{
		"-enabled", "-mode=publish",
		"-ledger=" + paths.ledger,
		"-sync=" + paths.sync,
		"-repository=" + paths.repository,
		"-work-root=" + filepath.Join(temp, "work"),
		"-owner=owner-main", "-device=publisher-1",
		"-document=document-1", "-revision=rev-0123456789abcdef01234567",
		"-holder=worker-1",
		"-apex=" + paths.apex,
		"-lock=" + paths.lock,
	}
	err := run(context.Background(), args, &bytes.Buffer{}, unavailablePublicationAPI{})
	if !errors.Is(err, errPublisherAPIUnavailable) {
		t.Fatalf("run error = %v, want unavailable API", err)
	}
	for _, path := range []string{paths.ledger, paths.sync, paths.repository, paths.apex, paths.lock} {
		if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
			t.Fatalf("unavailable adapter touched %q: %v", path, statErr)
		}
	}
}

func TestLiveAdapterPublishesOneDurableRevision(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	command := exec.Command("git", "init", "--bare", "--initial-branch=main", remote)
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("init remote: %v: %s", err, output)
	}
	apex := filepath.Join(root, "apex")
	if err := os.WriteFile(apex, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	syncPath := filepath.Join(root, "sync.db")
	store, err := v2sync.Open(syncPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterDevice("owner-main", "publisher-1", "registration-1", "Publisher", strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(v2publish.PublicationPayload{
		SchemaVersion: v2publish.PayloadSchemaVersion,
		Kind:          v2publish.LeadSheet,
		Path:          "songs/Test-Song.md",
		Source:        "# Test Song\n",
		Deleted:       false,
	})
	if err != nil {
		t.Fatal(err)
	}
	hash, _, err := v2sync.HashPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := store.Apply(v2sync.ApplyEnvelope{
		ProtocolVersion: v2sync.ProtocolVersion, OwnerID: "owner-main", DeviceID: "publisher-1",
		OperationID: "operation-1", OperationKind: "replace", DocumentID: "document-1",
		Title: "Test Song", Payload: payload, PayloadSHA256: hash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := apiConfig{
		Ledger: filepath.Join(root, "publication.db"), Sync: syncPath, Repository: remote,
		WorkRoot: filepath.Join(root, "work"), Owner: "owner-main", Device: "publisher-1",
		Document: "document-1", Revision: outcome.RevisionID, Holder: "worker-1",
		Apex: apex, Lock: filepath.Join(root, "publication.lock"),
	}
	if err := (livePublicationAPI{}).PublishOnce(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	verify := exec.Command("git", "--git-dir="+remote, "rev-list", "--count", "refs/heads/main")
	if output, err := verify.CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != "1" {
		t.Fatalf("remote commit count: %q %v", output, err)
	}
}

func TestParserRejectsUnknownFlagsAndPositionalArguments(t *testing.T) {
	if _, err := parseConfig([]string{"-unknown=value"}); err == nil || !strings.Contains(err.Error(), "parse flags") {
		t.Fatalf("unknown flag error = %v", err)
	}
	if _, err := parseConfig([]string{"anything"}); err == nil || !strings.Contains(err.Error(), "positional arguments") {
		t.Fatalf("positional argument error = %v", err)
	}
}
