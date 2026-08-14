package v2publish

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func canonicalBackupDestination(value string) (string, error) {
	if value == "" {
		return "", codeError(CodeInvalidConfig, "empty backup destination", nil)
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(absolute); err == nil {
		return "", codeError(CodeInvalidConfig, "backup destination already exists", nil)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}

func canonicalExisting(value string) string {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return filepath.Clean(value)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved
	}
	parent, parentErr := filepath.EvalSymlinks(filepath.Dir(absolute))
	if parentErr == nil {
		return filepath.Join(parent, filepath.Base(absolute))
	}
	return absolute
}

func pathWithin(path, root string) bool {
	path, root = filepath.Clean(path), filepath.Clean(root)
	return path == root || strings.HasPrefix(path, root+string(os.PathSeparator))
}

func (p *Publisher) backupDestinations(ledgerDestination, bundleDestination string) (string, string, error) {
	ledgerLexical, err := filepath.Abs(ledgerDestination)
	if err != nil {
		return "", "", err
	}
	bundleLexical, err := filepath.Abs(bundleDestination)
	if err != nil {
		return "", "", err
	}
	if ledgerLexical == bundleLexical {
		return "", "", codeError(CodeInvalidConfig, "ledger and Git bundle backup destinations must differ", nil)
	}
	lexicalReserved := []string{p.ledger.path, p.ledger.path + "-wal", p.ledger.path + "-shm", p.ledger.lockPath}
	for _, output := range []string{ledgerLexical, bundleLexical} {
		for _, reserved := range lexicalReserved {
			if filepath.Clean(output) == filepath.Clean(reserved) {
				return "", "", codeError(CodeInvalidConfig, "backup destination collides with live publication state", nil)
			}
		}
		if pathWithin(output, p.git.root) {
			return "", "", codeError(CodeInvalidConfig, "backup destination is inside the Git materializer work root", nil)
		}
	}
	ledgerOutput, err := canonicalBackupDestination(ledgerLexical)
	if err != nil {
		return "", "", err
	}
	bundleOutput, err := canonicalBackupDestination(bundleLexical)
	if err != nil {
		return "", "", err
	}
	if ledgerOutput == bundleOutput {
		return "", "", codeError(CodeInvalidConfig, "ledger and Git bundle backup destinations must differ", nil)
	}
	reserved := []string{
		canonicalExisting(p.ledger.path),
		canonicalExisting(p.ledger.path + "-wal"),
		canonicalExisting(p.ledger.path + "-shm"),
		canonicalExisting(p.ledger.lockPath),
	}
	workRoot := canonicalExisting(p.git.root)
	for _, output := range []string{ledgerOutput, bundleOutput} {
		for _, path := range reserved {
			if output == path {
				return "", "", codeError(CodeInvalidConfig, "backup destination collides with live publication state", nil)
			}
		}
		if pathWithin(output, workRoot) {
			return "", "", codeError(CodeInvalidConfig, "backup destination is inside the Git materializer work root", nil)
		}
	}
	return ledgerOutput, bundleOutput, nil
}

func temporarySibling(destination, kind string) (string, error) {
	file, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+"."+kind+"-*")
	if err != nil {
		return "", err
	}
	name := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	if err := os.Remove(name); err != nil {
		return "", err
	}
	return name, nil
}

// Backup takes an online SQLite backup and a verified Git bundle while holding
// the publication flock. Each artifact is built and verified under a unique
// temporary name before either final destination becomes visible. A remote
// branch change or bundle/head mismatch fails closed.
func (p *Publisher) Backup(ctx context.Context, holder, ledgerDestination, bundleDestination string) (BackupResult, error) {
	if !validHolder(holder) {
		return BackupResult{}, codeError(CodeInvalidPayload, "invalid backup lease holder", nil)
	}
	ledgerOutput, bundleOutput, err := p.backupDestinations(ledgerDestination, bundleDestination)
	if err != nil {
		return BackupResult{}, err
	}
	ledgerTemporary, err := temporarySibling(ledgerOutput, "sqlite")
	if err != nil {
		return BackupResult{}, err
	}
	defer os.Remove(ledgerTemporary)
	bundleTemporary, err := temporarySibling(bundleOutput, "bundle")
	if err != nil {
		return BackupResult{}, err
	}
	defer os.Remove(bundleTemporary)

	lease, err := p.ledger.AcquireLease(ctx, holder)
	if err != nil {
		return BackupResult{}, err
	}
	defer lease.Release()
	hooks := p.currentHooks()
	now := hookNow(hooks)
	headBefore, base, err := p.ensureGitBase(ctx, lease.Token(), now)
	if err != nil {
		return BackupResult{}, err
	}
	if err := p.ledger.Backup(ledgerTemporary); err != nil {
		return BackupResult{}, err
	}
	if err := p.injected(ctx, hooks, FailureBeforeBackupBundle, Intent{}); err != nil {
		return BackupResult{}, err
	}
	bundledHead, err := p.git.bundle(ctx, bundleTemporary)
	if err != nil {
		return BackupResult{}, err
	}
	headAfter, err := p.git.RemoteHead(ctx)
	if err != nil {
		return BackupResult{}, err
	}
	if headAfter != headBefore || bundledHead != headBefore {
		return BackupResult{}, codeError(CodeRemoteDrift, fmt.Sprintf("remote/bundle heads changed during backup: before=%s bundled=%s after=%s", headBefore, bundledHead, headAfter), nil)
	}
	if err := VerifyBundle(ctx, bundleTemporary); err != nil {
		return BackupResult{}, err
	}
	if err := os.Rename(bundleTemporary, bundleOutput); err != nil {
		return BackupResult{}, err
	}
	bundleTemporary = ""
	if err := os.Rename(ledgerTemporary, ledgerOutput); err != nil {
		_ = os.Remove(bundleOutput)
		return BackupResult{}, err
	}
	ledgerTemporary = ""
	return BackupResult{LedgerPath: ledgerOutput, BundlePath: bundleOutput, LedgerBase: base, RemoteHead: headAfter, Skewed: base != headAfter}, nil
}
