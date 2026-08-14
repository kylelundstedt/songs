package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"songs.exe.dev/internal/v2publish"
	"songs.exe.dev/internal/v2sync"
)

type syncBackupFunc func(string) error

func (function syncBackupFunc) Backup(destination string) error { return function(destination) }

func runBackupRestore(root, apex string, result *evidence) error {
	h, err := newHarness(root, "backup-restore", apex, v2publish.Hooks{})
	if err != nil {
		return err
	}
	defer h.close()
	outcome, err := applyRevision(h.store, "backup-operation", "backup-song", "Backup Song", "", leadPayload("songs/Backup-Song.md", "Backup Song", "Body"))
	if err != nil {
		return err
	}
	fired := false
	h.publisher.SetHooks(v2publish.Hooks{
		Now: func() time.Time { return fixedNow },
		Failure: func(point v2publish.FailurePoint, _ v2publish.Intent) error {
			if point == v2publish.FailureAfterPush && !fired {
				fired = true
				return errors.New("remote accepted before process loss")
			}
			return nil
		},
	})
	request := publishRequest("backup-song", outcome.RevisionID, "backup-publication-worker")
	unfinalized, publishErr := h.publisher.Publish(context.Background(), request)
	if err := require(v2publish.IsCode(publishErr, v2publish.CodeInjectedFailure) && unfinalized.State == v2publish.IntentCommitted && unfinalized.Commit != "", "backup drill did not create remote-accepted unfinalized work"); err != nil {
		return err
	}
	sourceSnapshot, err := h.store.SemanticSnapshot(ownerID, deviceID)
	if err != nil {
		return err
	}
	continuity, err := newContinuityHandlers(filepath.Join(h.root, "continuity"))
	if err != nil {
		return err
	}
	defer continuity.close()
	competing, err := v2publish.OpenLedger(h.ledgerPath, h.lockPath)
	if err != nil {
		return err
	}
	defer competing.Close()

	backupRoot := filepath.Join(h.root, "coordinated-backup")
	syncBackedUp := false
	flockObserved := false
	continuityInsideFlock := false
	legacyStatus, shellStatus, manifestStatus := 0, 0, 0
	backupSource := syncBackupFunc(func(destination string) error {
		ctx, cancel := contextWithBriefTimeout()
		lease, leaseErr := competing.AcquireLease(ctx, "competing-backup-worker")
		cancel()
		if leaseErr == nil {
			_ = lease.Release()
			return errors.New("sync backup callback was outside publication flock")
		}
		if !v2publish.IsCode(leaseErr, v2publish.CodeLeaseBusy) {
			return leaseErr
		}
		flockObserved = true
		if err := h.store.Backup(destination); err != nil {
			return err
		}
		syncBackedUp = true
		var exerciseErr error
		legacyStatus, shellStatus, manifestStatus, exerciseErr = continuity.exercise()
		if exerciseErr != nil {
			return exerciseErr
		}
		if legacyStatus != http.StatusOK || shellStatus != http.StatusOK || manifestStatus != http.StatusOK {
			return fmt.Errorf("handler continuity statuses = %d/%d/%d", legacyStatus, shellStatus, manifestStatus)
		}
		continuityInsideFlock = true
		return nil
	})
	backupManifest, err := h.publisher.CoordinatedBackup(context.Background(), backupSource, "coordinated-backup-worker", backupRoot)
	if err != nil {
		return fmt.Errorf("coordinated backup: %w", err)
	}
	backupSkewed := backupManifest.LedgerBase != backupManifest.RemoteHead
	if err := require(syncBackedUp && flockObserved && continuityInsideFlock && backupSkewed, "coordinated backup did not capture the intended skew under flock"); err != nil {
		return err
	}
	if err := v2publish.VerifyCoordinatedBackup(context.Background(), backupRoot); err != nil {
		return err
	}
	restored, err := v2publish.RestoreCoordinatedBackup(context.Background(), backupRoot, filepath.Join(h.root, "restored"))
	if err != nil {
		return err
	}
	restoredLedger, err := v2publish.OpenLedger(restored.PublicationPath, restored.LockPath)
	if err != nil {
		return err
	}
	if err := restoredLedger.Integrity(); err != nil {
		_ = restoredLedger.Close()
		return err
	}
	if err := restoredLedger.EnablePublication(context.Background()); err != nil {
		_ = restoredLedger.Close()
		return err
	}
	if err := restoredLedger.Close(); err != nil {
		return err
	}
	restoredSync, err := v2sync.Open(restored.SyncPath)
	if err != nil {
		return err
	}
	defer restoredSync.Close()
	restoredSnapshot, err := restoredSync.SemanticSnapshot(ownerID, deviceID)
	if err != nil {
		return err
	}
	if err := restoredSync.Integrity(); err != nil {
		return err
	}
	if err := h.store.Integrity(); err != nil {
		return err
	}
	restoredPublisher, err := v2publish.Open(v2publish.Options{
		LedgerPath: restored.PublicationPath, LockPath: restored.LockPath,
		Remote: restored.RemotePath, WorkRoot: filepath.Join(restored.Root, "work"), Sync: restoredSync,
		ValidatorOptions: v2publish.ValidatorOptions{ApexPath: apex},
		Hooks:            v2publish.Hooks{Now: func() time.Time { return fixedNow }},
	})
	if err != nil {
		return err
	}
	defer restoredPublisher.Close()
	beforeRecovery, err := remoteCount(restored.RemotePath)
	if err != nil {
		return err
	}
	recovered, err := restoredPublisher.Recover(context.Background(), request)
	if err != nil {
		return fmt.Errorf("recover restored unfinalized publication: %w", err)
	}
	afterRecovery, err := remoteCount(restored.RemotePath)
	if err != nil {
		return err
	}
	if err := restoredPublisher.Integrity(context.Background(), "restored-integrity-worker"); err != nil {
		return err
	}
	published, err := restoredPublisher.Ledger().PublishedDocument(ownerID, "backup-song")
	if err != nil {
		return err
	}
	restoredEquivalent := bytes.Equal(sourceSnapshot, restoredSnapshot)
	restoredIntegrity := recovered.State == v2publish.IntentFinalized && published.RevisionID == outcome.RevisionID && afterRecovery == beforeRecovery
	if err := require(restoredEquivalent && restoredIntegrity && recovered.Commit == unfinalized.Commit, "restored ledgers and bundle did not converge without a duplicate commit"); err != nil {
		return err
	}

	result.BackupRestore.SyncOnlineBackup = syncBackedUp
	result.BackupRestore.SyncBackupInsidePublicationFlock = flockObserved
	result.BackupRestore.PublicationOnlineBackup = true
	result.BackupRestore.GitBundleVerified = true
	result.BackupRestore.BackupSkewDetected = backupSkewed
	result.BackupRestore.RestoredSyncEquivalent = restoredEquivalent
	result.BackupRestore.RestoredIntegrity = restoredIntegrity
	result.BackupRestore.UnfinalizedState = string(unfinalized.State)
	result.BackupRestore.RecoveredState = string(recovered.State)
	result.BackupRestore.RemoteCommitDeltaDuringRecovery = afterRecovery - beforeRecovery
	result.BackupRestore.SameCommitIdentity = recovered.Commit == unfinalized.Commit
	result.HandlerContinuity.V1Status = legacyStatus
	result.HandlerContinuity.V2ShellStatus = shellStatus
	result.HandlerContinuity.V2ManifestStatus = manifestStatus
	result.HandlerContinuity.DuringBackupFlock = continuityInsideFlock
	return nil
}

func runDeploymentGuard(_ string, _ string, result *evidence) error {
	working, err := os.Getwd()
	if err != nil {
		return err
	}
	relative := filepath.FromSlash("cmd/v2publisher/main.go")
	raw, err := os.ReadFile(filepath.Join(working, relative))
	if err != nil {
		return err
	}
	text := string(raw)
	enabledDefaultFalse := strings.Contains(text, `flags.BoolVar(&cfg.enabled, "enabled", false`)
	flagNames := []string{"mode", "ledger", "sync", "repository", "work-root", "owner", "device", "document", "revision", "holder", "actor", "apex", "lock"}
	operationalDefaultsEmpty := true
	for _, name := range flagNames {
		needle := `"` + name + `", ""`
		if !strings.Contains(text, needle) {
			operationalDefaultsEmpty = false
			break
		}
	}
	disabledConfigurationRejected := strings.Contains(text, "publication configuration supplied without -enabled") && strings.Contains(text, "if !cfg.enabled {")
	oneShotInterface := strings.Contains(text, "PublishOnce(context.Context, apiConfig) error") && strings.Contains(text, "ReconcileOnce(context.Context, apiConfig) error") && strings.Contains(text, "publisher.Publish(ctx") && strings.Contains(text, "publisher.Reconcile(ctx")
	if err := require(enabledDefaultFalse && operationalDefaultsEmpty && disabledConfigurationRejected && oneShotInterface, "publisher command source is not fail-closed by default"); err != nil {
		return err
	}
	result.DeploymentGuard.CheckedFile = filepath.ToSlash(relative)
	result.DeploymentGuard.EnabledDefaultFalse = enabledDefaultFalse
	result.DeploymentGuard.OperationalDefaultsEmpty = operationalDefaultsEmpty
	result.DeploymentGuard.DisabledConfigurationRejected = disabledConfigurationRejected
	result.DeploymentGuard.OneShotInterface = oneShotInterface
	return nil
}
