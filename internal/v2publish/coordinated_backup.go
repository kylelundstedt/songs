package v2publish

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"songs.exe.dev/internal/v2sync"
)

type SyncBackupSource interface {
	Backup(destination string) error
}

type CoordinatedBackupManifest struct {
	SchemaVersion     string `json:"schema_version"`
	PublicationSchema string `json:"publication_schema"`
	SyncSchema        string `json:"sync_schema"`
	LedgerBase        string `json:"ledger_base"`
	RemoteHead        string `json:"remote_head"`
	SyncSHA256        string `json:"sync_sha256"`
	PublicationSHA256 string `json:"publication_sha256"`
	BundleSHA256      string `json:"bundle_sha256"`
}

type RestoredBackup struct {
	Root, SyncPath, PublicationPath, RemotePath, LockPath string
}

func fileDigest(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeManifest(path string, manifest CoordinatedBackupManifest) error {
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// CoordinatedBackup captures the sync ledger, publication ledger, and remote
// Git history under one publication flock, verifies all artifacts, and exposes
// them through one atomic directory rename.
func (p *Publisher) CoordinatedBackup(ctx context.Context, syncSource SyncBackupSource, holder, destination string) (CoordinatedBackupManifest, error) {
	if syncSource == nil || !validHolder(holder) || destination == "" {
		return CoordinatedBackupManifest{}, codeError(CodeInvalidConfig, "coordinated backup requires sync source, holder, and destination", nil)
	}
	absolute, err := filepath.Abs(destination)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return CoordinatedBackupManifest{}, codeError(CodeInvalidConfig, "coordinated backup destination already exists", nil)
	} else if !os.IsNotExist(err) {
		return CoordinatedBackupManifest{}, err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	temporary, err := os.MkdirTemp(filepath.Dir(absolute), "."+filepath.Base(absolute)+"-*")
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	defer os.RemoveAll(temporary)
	lease, err := p.ledger.AcquireLease(ctx, holder)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	defer lease.Release()
	now := hookNow(p.currentHooks())
	headBefore, base, err := p.ensureGitBase(ctx, lease.Token(), now)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	syncPath := filepath.Join(temporary, "sync.sqlite")
	publicationPath := filepath.Join(temporary, "publication.sqlite")
	bundlePath := filepath.Join(temporary, "publication.bundle")
	if err := syncSource.Backup(syncPath); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if err := p.ledger.Backup(publicationPath); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	bundledHead, err := p.git.bundle(ctx, bundlePath)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	headAfter, err := p.git.RemoteHead(ctx)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if headBefore != headAfter || bundledHead != headBefore {
		return CoordinatedBackupManifest{}, codeError(CodeRemoteDrift, "remote changed during coordinated backup", nil)
	}
	manifest := CoordinatedBackupManifest{SchemaVersion: "v2backup-1", PublicationSchema: SchemaVersion, SyncSchema: v2sync.SchemaVersion, LedgerBase: base, RemoteHead: headAfter}
	if manifest.SyncSHA256, err = fileDigest(syncPath); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if manifest.PublicationSHA256, err = fileDigest(publicationPath); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if manifest.BundleSHA256, err = fileDigest(bundlePath); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if err := writeManifest(filepath.Join(temporary, "manifest.json"), manifest); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if err := VerifyCoordinatedBackup(ctx, temporary); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	directory, err := os.Open(temporary)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return CoordinatedBackupManifest{}, err
	}
	_ = directory.Close()
	if err := os.Rename(temporary, absolute); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	return manifest, nil
}

func decodeBackupManifest(path string) (CoordinatedBackupManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return CoordinatedBackupManifest{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var manifest CoordinatedBackupManifest
	if err := decoder.Decode(&manifest); err != nil {
		return CoordinatedBackupManifest{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return CoordinatedBackupManifest{}, errors.New("coordinated backup manifest has trailing JSON")
	}
	return manifest, nil
}

func VerifyCoordinatedBackup(ctx context.Context, directory string) error {
	manifest, err := decodeBackupManifest(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return err
	}
	if manifest.SchemaVersion != "v2backup-1" || manifest.PublicationSchema != SchemaVersion || manifest.SyncSchema != v2sync.SchemaVersion {
		return codeError(CodeIntegrity, "coordinated backup schema mismatch", nil)
	}
	checks := []struct{ name, want string }{
		{"sync.sqlite", manifest.SyncSHA256}, {"publication.sqlite", manifest.PublicationSHA256}, {"publication.bundle", manifest.BundleSHA256},
	}
	for _, check := range checks {
		got, err := fileDigest(filepath.Join(directory, check.name))
		if err != nil {
			return err
		}
		if got != check.want {
			return codeError(CodeIntegrity, check.name+" digest mismatch", nil)
		}
	}
	temporary, err := os.MkdirTemp("", "v2publish-coordinated-verify-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err := copyBackupFile(filepath.Join(directory, "sync.sqlite"), filepath.Join(temporary, "sync.sqlite")); err != nil {
		return err
	}
	if err := copyBackupFile(filepath.Join(directory, "publication.sqlite"), filepath.Join(temporary, "publication.sqlite")); err != nil {
		return err
	}
	syncStore, err := v2sync.Open(filepath.Join(temporary, "sync.sqlite"))
	if err != nil {
		return err
	}
	if err := syncStore.Integrity(); err != nil {
		_ = syncStore.Close()
		return err
	}
	if err := syncStore.Close(); err != nil {
		return err
	}
	ledger, err := OpenLedger(filepath.Join(temporary, "publication.sqlite"), filepath.Join(temporary, "verify.lock"))
	if err != nil {
		return err
	}
	if err := ledger.Integrity(); err != nil {
		_ = ledger.Close()
		return err
	}
	if err := ledger.Close(); err != nil {
		return err
	}
	return VerifyBundle(ctx, filepath.Join(directory, "publication.bundle"))
}

func copyBackupFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Sync(); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

// RestoreCoordinatedBackup verifies the complete package, restores into one new
// root, rotates/disables publication fencing, and never writes over live paths.
func RestoreCoordinatedBackup(ctx context.Context, backupDirectory, destinationRoot string) (RestoredBackup, error) {
	if err := VerifyCoordinatedBackup(ctx, backupDirectory); err != nil {
		return RestoredBackup{}, err
	}
	absolute, err := filepath.Abs(destinationRoot)
	if err != nil {
		return RestoredBackup{}, err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return RestoredBackup{}, codeError(CodeInvalidConfig, "restore destination already exists", nil)
	} else if !os.IsNotExist(err) {
		return RestoredBackup{}, err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return RestoredBackup{}, err
	}
	temporary, err := os.MkdirTemp(filepath.Dir(absolute), "."+filepath.Base(absolute)+"-restore-*")
	if err != nil {
		return RestoredBackup{}, err
	}
	defer os.RemoveAll(temporary)
	if err := copyBackupFile(filepath.Join(backupDirectory, "sync.sqlite"), filepath.Join(temporary, "sync.sqlite")); err != nil {
		return RestoredBackup{}, err
	}
	if err := copyBackupFile(filepath.Join(backupDirectory, "publication.sqlite"), filepath.Join(temporary, "publication.sqlite")); err != nil {
		return RestoredBackup{}, err
	}
	if err := RestoreBundle(ctx, filepath.Join(backupDirectory, "publication.bundle"), filepath.Join(temporary, "remote.git")); err != nil {
		return RestoredBackup{}, err
	}
	if err := os.Rename(temporary, absolute); err != nil {
		return RestoredBackup{}, err
	}
	result := RestoredBackup{Root: absolute, SyncPath: filepath.Join(absolute, "sync.sqlite"), PublicationPath: filepath.Join(absolute, "publication.sqlite"), RemotePath: filepath.Join(absolute, "remote.git"), LockPath: filepath.Join(absolute, "publication.lock")}
	ledger, err := OpenLedger(result.PublicationPath, result.LockPath)
	if err != nil {
		_ = os.RemoveAll(absolute)
		return RestoredBackup{}, err
	}
	if err := ledger.DisablePublication(ctx, "restore-fence"); err != nil {
		_ = ledger.Close()
		_ = os.RemoveAll(absolute)
		return RestoredBackup{}, err
	}
	if err := ledger.Close(); err != nil {
		_ = os.RemoveAll(absolute)
		return RestoredBackup{}, err
	}
	return result, nil
}
