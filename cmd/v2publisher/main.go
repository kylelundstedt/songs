// Command v2publisher is the disabled-by-default, one-shot entry point for
// TASK-018 publication and external Git reconciliation.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"songs.exe.dev/internal/v2bootstrap"
	"songs.exe.dev/internal/v2publish"
	"songs.exe.dev/internal/v2sync"
)

const (
	modePublish   = "publish"
	modeReconcile = "reconcile"
	modeBootstrap = "bootstrap"
)

var errPublisherAPIUnavailable = errors.New("internal/v2publish API is unavailable; publication and reconciliation remain disabled")

// config contains process controls. apiConfig is kept separate so the eventual
// internal/v2publish adapter cannot observe or reinterpret the enable gate.
type config struct {
	enabled bool
	mode    string
	api     apiConfig
}

// apiConfig is the deliberately narrow configuration boundary anticipated for
// internal/v2publish. Fields remain opaque here: opening databases, inspecting
// Git, executing Apex, and acquiring a fenced lock are exclusively API work.
type apiConfig struct {
	Ledger     string
	Sync       string
	Repository string
	WorkRoot   string
	Owner      string
	Device     string
	Document   string
	Revision   string
	Holder     string
	Actor      string
	Apex       string
	Lock       string
}

// publicationAPI models exactly one bounded operation per process invocation.
// There is intentionally no Start, Serve, Watch, or retry-loop method.
type publicationAPI interface {
	PublishOnce(context.Context, apiConfig) error
	ReconcileOnce(context.Context, apiConfig) error
	BootstrapOnce(context.Context, apiConfig) error
}

type unavailablePublicationAPI struct{}

func (unavailablePublicationAPI) PublishOnce(context.Context, apiConfig) error {
	return errPublisherAPIUnavailable
}

func (unavailablePublicationAPI) BootstrapOnce(context.Context, apiConfig) error {
	return errPublisherAPIUnavailable
}

func (unavailablePublicationAPI) ReconcileOnce(context.Context, apiConfig) error {
	return errPublisherAPIUnavailable
}

type livePublicationAPI struct{}

func (livePublicationAPI) PublishOnce(ctx context.Context, cfg apiConfig) error {
	publisher, syncStore, err := openPublisher(cfg)
	if err != nil {
		return err
	}
	defer syncStore.Close()
	defer publisher.Close()
	_, err = publisher.Publish(ctx, v2publish.PublishRequest{
		OwnerID: cfg.Owner, DeviceID: cfg.Device, DocumentID: cfg.Document,
		RevisionID: cfg.Revision, Holder: cfg.Holder,
	})
	return err
}

func (livePublicationAPI) BootstrapOnce(ctx context.Context, cfg apiConfig) error {
	snapshot, err := v2bootstrap.LoadEmbedded()
	if err != nil {
		return fmt.Errorf("load reviewed bootstrap: %w", err)
	}
	baseline, err := snapshot.BaselineDocuments()
	if err != nil {
		return err
	}
	publicationDocuments := make([]v2publish.BootstrapDocument, 0, len(baseline))
	for _, document := range baseline {
		kind := v2publish.LeadSheet
		if document.Kind == "set-list" {
			kind = v2publish.SetList
		}
		publicationDocuments = append(publicationDocuments, v2publish.BootstrapDocument{DocumentID: document.ID, Title: document.Title, Kind: kind, Path: document.Path, Source: document.Source})
	}
	// Revision identity is part of the reviewed archive manifest anchor.
	for index := range publicationDocuments {
		payload, err := json.Marshal(v2publish.PublicationPayload{SchemaVersion: v2publish.PayloadSchemaVersion, Kind: publicationDocuments[index].Kind, Path: publicationDocuments[index].Path, Source: string(publicationDocuments[index].Source)})
		if err != nil {
			return err
		}
		hash, canonical, err := v2sync.HashPayload(payload)
		if err != nil {
			return err
		}
		revision := v2sync.BaselineRevision{DocumentID: publicationDocuments[index].DocumentID, Title: publicationDocuments[index].Title, Payload: canonical, PayloadSHA256: hash}
		revisionID, err := v2sync.BaselineRevisionID(cfg.Owner, revision)
		if err != nil {
			return err
		}
		publicationDocuments[index].RevisionID = revisionID
	}
	manifestHash, err := v2publish.BootstrapManifestSHA256(publicationDocuments)
	if err != nil {
		return err
	}
	syncStore, err := v2sync.Open(cfg.Sync)
	if err != nil {
		return fmt.Errorf("open sync ledger: %w", err)
	}
	defer syncStore.Close()
	publisher, err := v2publish.Open(v2publish.Options{LedgerPath: cfg.Ledger, LockPath: cfg.Lock, Remote: cfg.Repository, WorkRoot: cfg.WorkRoot, Sync: syncStore, BootstrapManifestSHA256: manifestHash, ValidatorOptions: v2publish.ValidatorOptions{ApexPath: cfg.Apex}})
	if err != nil {
		return err
	}
	defer publisher.Close()
	revisions := make([]v2sync.BaselineRevision, 0, len(publicationDocuments))
	documents := make([]v2sync.DocumentMapping, 0, len(publicationDocuments))
	for _, document := range publicationDocuments {
		payload, err := json.Marshal(v2publish.PublicationPayload{SchemaVersion: v2publish.PayloadSchemaVersion, Kind: document.Kind, Path: document.Path, Source: string(document.Source)})
		if err != nil {
			return err
		}
		hash, canonical, err := v2sync.HashPayload(payload)
		if err != nil {
			return err
		}
		revisions = append(revisions, v2sync.BaselineRevision{RevisionID: document.RevisionID, DocumentID: document.DocumentID, Title: document.Title, Payload: canonical, PayloadSHA256: hash})
		documents = append(documents, v2sync.DocumentMapping{DocumentID: document.DocumentID, Title: document.Title, CurrentRevisionID: document.RevisionID})
	}
	if _, err := syncStore.BootstrapBaseline(v2sync.BaselineBootstrapEnvelope{ProtocolVersion: v2sync.ProtocolVersion, OwnerID: cfg.Owner, DeviceID: cfg.Device, OperationID: "baseline-bootstrap", Revisions: revisions, Documents: documents}); err != nil {
		return err
	}
	if err := publisher.BootstrapArchive(ctx, cfg.Owner, cfg.Device, cfg.Holder, publicationDocuments); err != nil {
		return err
	}
	head, initialized, err := publisher.Ledger().GitBase()
	if err != nil {
		return fmt.Errorf("read durable archive baseline head: %w", err)
	}
	if !initialized || head == "" {
		return errors.New("read durable archive baseline head: baseline is not initialized")
	}
	publications := make([]v2sync.PublicationMapping, 0, len(publicationDocuments))
	for _, document := range publicationDocuments {
		publications = append(publications, v2sync.PublicationMapping{DocumentID: document.DocumentID, RevisionID: document.RevisionID, CommitHash: head})
	}
	return syncStore.BootstrapPublications(v2sync.PublicationBaselineEnvelope{OwnerID: cfg.Owner, DeviceID: cfg.Device, OperationID: "publication-baseline", Publications: publications})
}

func (livePublicationAPI) ReconcileOnce(ctx context.Context, cfg apiConfig) error {
	publisher, syncStore, err := openPublisher(cfg)
	if err != nil {
		return err
	}
	defer syncStore.Close()
	defer publisher.Close()
	_, err = publisher.Reconcile(ctx, v2publish.ReconcileRequest{
		OwnerID: cfg.Owner, DeviceID: cfg.Device, Holder: cfg.Holder, Actor: cfg.Actor,
	})
	return err
}

func openPublisher(cfg apiConfig) (*v2publish.Publisher, *v2sync.Store, error) {
	syncStore, err := v2sync.Open(cfg.Sync)
	if err != nil {
		return nil, nil, fmt.Errorf("open sync ledger: %w", err)
	}
	publisher, err := v2publish.Open(v2publish.Options{
		LedgerPath: cfg.Ledger, LockPath: cfg.Lock, Remote: cfg.Repository,
		WorkRoot: cfg.WorkRoot, Sync: syncStore,
		ValidatorOptions: v2publish.ValidatorOptions{ApexPath: cfg.Apex},
	})
	if err != nil {
		_ = syncStore.Close()
		return nil, nil, fmt.Errorf("open publisher: %w", err)
	}
	return publisher, syncStore, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, livePublicationAPI{}); err != nil {
		fmt.Fprintln(os.Stderr, "v2publisher:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer, api publicationAPI) error {
	cfg, err := parseConfig(args)
	if err != nil {
		return err
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}
	if !cfg.enabled {
		_, err := fmt.Fprintln(stdout, "v2publisher disabled; no publication, reconciliation, or bootstrap attempted")
		return err
	}
	if api == nil {
		return errors.New("publisher API is not configured")
	}

	switch cfg.mode {
	case modePublish:
		err = api.PublishOnce(ctx, cfg.api)
	case modeReconcile:
		err = api.ReconcileOnce(ctx, cfg.api)
	case modeBootstrap:
		err = api.BootstrapOnce(ctx, cfg.api)
	default:
		// validateConfig makes this unreachable. Keep the dispatch fail-closed if
		// validation and execution are ever refactored independently.
		return fmt.Errorf("unsupported mode %q", cfg.mode)
	}
	if err != nil {
		return fmt.Errorf("%s once: %w", cfg.mode, err)
	}
	_, err = fmt.Fprintf(stdout, "v2publisher %s completed\n", cfg.mode)
	return err
}

func parseConfig(args []string) (config, error) {
	var cfg config
	flags := flag.NewFlagSet("v2publisher", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&cfg.enabled, "enabled", false, "explicitly enable one publication or reconciliation operation")
	flags.StringVar(&cfg.mode, "mode", "", "one-shot operation: publish, reconcile, or bootstrap (required when enabled)")
	flags.StringVar(&cfg.api.Ledger, "ledger", "", "publication ledger configuration (required when enabled)")
	flags.StringVar(&cfg.api.Sync, "sync", "", "durable sync configuration (required when enabled)")
	flags.StringVar(&cfg.api.Repository, "repository", "", "Git remote configuration (required when enabled)")
	flags.StringVar(&cfg.api.WorkRoot, "work-root", "", "isolated Git workspace root (required when enabled)")
	flags.StringVar(&cfg.api.Owner, "owner", "", "owner identity (required when enabled)")
	flags.StringVar(&cfg.api.Device, "device", "", "publisher device identity (required when enabled)")
	flags.StringVar(&cfg.api.Document, "document", "", "current document identity (required for publish)")
	flags.StringVar(&cfg.api.Revision, "revision", "", "current revision identity (required for publish)")
	flags.StringVar(&cfg.api.Holder, "holder", "", "stable worker/operation holder identity (required when enabled)")
	flags.StringVar(&cfg.api.Actor, "actor", "", "operator attribution for reconciliation (optional)")
	flags.StringVar(&cfg.api.Apex, "apex", "", "Apex executable path (required when enabled)")
	flags.StringVar(&cfg.api.Lock, "lock", "", "fenced publication lock configuration (required when enabled)")
	if err := flags.Parse(args); err != nil {
		return config{}, fmt.Errorf("parse flags: %w", err)
	}
	if flags.NArg() != 0 {
		return config{}, errors.New("positional arguments are not accepted")
	}
	return cfg, nil
}

func validateConfig(cfg config) error {
	configured := configuredFields(cfg)
	if !cfg.enabled {
		if len(configured) != 0 {
			return fmt.Errorf("publication configuration supplied without -enabled: %s", strings.Join(configured, ", "))
		}
		return nil
	}

	var missing []string
	if cfg.mode == "" {
		missing = append(missing, "-mode")
	}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"-ledger", cfg.api.Ledger},
		{"-sync", cfg.api.Sync},
		{"-repository", cfg.api.Repository},
		{"-work-root", cfg.api.WorkRoot},
		{"-owner", cfg.api.Owner},
		{"-device", cfg.api.Device},
		{"-holder", cfg.api.Holder},
		{"-apex", cfg.api.Apex},
		{"-lock", cfg.api.Lock},
	} {
		if strings.TrimSpace(field.value) == "" {
			missing = append(missing, field.name)
		}
	}
	if cfg.mode == modePublish {
		if strings.TrimSpace(cfg.api.Document) == "" {
			missing = append(missing, "-document")
		}
		if strings.TrimSpace(cfg.api.Revision) == "" {
			missing = append(missing, "-revision")
		}
	}
	if len(missing) != 0 {
		return fmt.Errorf("enabled publisher requires complete configuration; missing: %s", strings.Join(missing, ", "))
	}
	if cfg.mode != modePublish && cfg.mode != modeReconcile && cfg.mode != modeBootstrap {
		return fmt.Errorf("invalid -mode %q; want %q, %q, or %q", cfg.mode, modePublish, modeReconcile, modeBootstrap)
	}
	if (cfg.mode == modeReconcile || cfg.mode == modeBootstrap) && (cfg.api.Document != "" || cfg.api.Revision != "") {
		return errors.New("-document and -revision are accepted only in publish mode")
	}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"-mode", cfg.mode},
		{"-ledger", cfg.api.Ledger},
		{"-sync", cfg.api.Sync},
		{"-repository", cfg.api.Repository},
		{"-work-root", cfg.api.WorkRoot},
		{"-owner", cfg.api.Owner},
		{"-device", cfg.api.Device},
		{"-document", cfg.api.Document},
		{"-revision", cfg.api.Revision},
		{"-holder", cfg.api.Holder},
		{"-actor", cfg.api.Actor},
		{"-apex", cfg.api.Apex},
		{"-lock", cfg.api.Lock},
	} {
		if strings.TrimSpace(field.value) != field.value {
			return fmt.Errorf("%s must not contain leading or trailing whitespace", field.name)
		}
	}
	return nil
}

func configuredFields(cfg config) []string {
	var fields []string
	for _, field := range []struct {
		name  string
		value string
	}{
		{"-mode", cfg.mode},
		{"-ledger", cfg.api.Ledger},
		{"-sync", cfg.api.Sync},
		{"-repository", cfg.api.Repository},
		{"-work-root", cfg.api.WorkRoot},
		{"-owner", cfg.api.Owner},
		{"-device", cfg.api.Device},
		{"-document", cfg.api.Document},
		{"-revision", cfg.api.Revision},
		{"-holder", cfg.api.Holder},
		{"-actor", cfg.api.Actor},
		{"-apex", cfg.api.Apex},
		{"-lock", cfg.api.Lock},
	} {
		if field.value != "" {
			fields = append(fields, field.name)
		}
	}
	return fields
}
