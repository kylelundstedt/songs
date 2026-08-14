package v2publish

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Lease holds an OS flock for its full lifetime. The durable token is checked
// by every publication-ledger transition, so a worker whose process-local lock
// was lost cannot continue under an old generation.
type Lease struct {
	ledger *Ledger
	file   *os.File
	token  FenceToken
	closed bool
}

func (l *Lease) Token() FenceToken { return l.token }

func openLockFile(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return nil, codeError(CodeInvalidConfig, "publication lock path is a symlink", err)
		}
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, codeError(CodeInvalidConfig, "publication lock path is not a regular file", nil)
	}
	return file, nil
}

func (l *Ledger) AcquireLease(ctx context.Context, holder string) (*Lease, error) {
	if !validHolder(holder) {
		return nil, codeError(CodeInvalidPayload, "invalid publication lease holder", nil)
	}
	file, err := openLockFile(l.lockPath)
	if err != nil {
		return nil, err
	}
	locked := false
	defer func() {
		if !locked {
			_ = file.Close()
		}
	}()
	for {
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			locked = true
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, codeError(CodeLeaseBusy, "publication lease is held by another worker", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}

	tx, err := l.db.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		locked = false
		return nil, err
	}
	defer tx.Rollback()
	var epoch, generation int64
	var disabled int
	if err := tx.QueryRow(`SELECT epoch,generation,disabled FROM v2publish_lease WHERE singleton=1`).Scan(&epoch, &generation, &disabled); err != nil {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		locked = false
		return nil, err
	}
	if disabled != 0 {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		locked = false
		return nil, codeError(CodeLeaseBusy, "publication is durably fenced off", nil)
	}
	generation++
	now := time.Now().UTC().Unix()
	if _, err := tx.Exec(`UPDATE v2publish_lease SET generation=?,holder=?,acquired_unix=? WHERE singleton=1`, generation, holder, now); err != nil {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		locked = false
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		locked = false
		return nil, err
	}
	return &Lease{ledger: l, file: file, token: FenceToken{Epoch: epoch, Generation: generation, Holder: holder}}, nil
}

func (l *Lease) Release() error {
	if l == nil || l.closed {
		return nil
	}
	l.closed = true
	var durableErr error
	tx, err := l.ledger.db.Begin()
	if err != nil {
		durableErr = err
	} else {
		result, updateErr := tx.Exec(`UPDATE v2publish_lease SET holder='',acquired_unix=0 WHERE singleton=1 AND epoch=? AND generation=? AND holder=?`, l.token.Epoch, l.token.Generation, l.token.Holder)
		if updateErr != nil {
			durableErr = updateErr
			_ = tx.Rollback()
		} else if count, rowsErr := result.RowsAffected(); rowsErr != nil {
			durableErr = rowsErr
			_ = tx.Rollback()
		} else if count != 1 {
			durableErr = codeError(CodeStaleFence, "publication lease was already superseded", nil)
			_ = tx.Rollback()
		} else {
			durableErr = tx.Commit()
		}
	}
	unlockErr := unix.Flock(int(l.file.Fd()), unix.LOCK_UN)
	closeErr := l.file.Close()
	if durableErr != nil {
		return durableErr
	}
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}

// DisablePublication is the rollback primitive: it waits for the current OS
// lock, increments both durable fencing dimensions, and leaves future Acquire
// calls disabled without deleting queued work.
func (l *Ledger) DisablePublication(ctx context.Context, holder string) error {
	lease, err := l.AcquireLease(ctx, holder)
	if err != nil {
		return err
	}
	defer func() {
		// The durable token is intentionally invalidated below, so Release cannot
		// clear it. Only the flock/descriptor need to be released here.
		_ = unix.Flock(int(lease.file.Fd()), unix.LOCK_UN)
		_ = lease.file.Close()
		lease.closed = true
	}()
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertFenceTx(tx, lease.token); err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE v2publish_lease SET epoch=epoch+1,generation=generation+1,holder='',acquired_unix=0,disabled=1 WHERE singleton=1`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// EnablePublication is deliberately an offline/operator primitive. It requires
// possession of the OS lock and creates a fresh epoch before workers can run.
func (l *Ledger) EnablePublication(ctx context.Context) error {
	file, err := openLockFile(l.lockPath)
	if err != nil {
		return err
	}
	defer file.Close()
	for {
		if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
			break
		} else if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return codeError(CodeLeaseBusy, "cannot enable publication while a worker holds the lock", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	_, err = l.db.Exec(`UPDATE v2publish_lease SET epoch=epoch+1,generation=generation+1,holder='',acquired_unix=0,disabled=0 WHERE singleton=1`)
	return err
}
