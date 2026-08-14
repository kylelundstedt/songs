package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songs.exe.dev/internal/v2publish"
)

func publishBaseline(h *harness, operation, document, title, path string) (string, error) {
	outcome, err := applyRevision(h.store, operation, document, title, "", leadPayload(path, title, "Published body"))
	if err != nil {
		return "", err
	}
	publication, err := h.publisher.Publish(context.Background(), publishRequest(document, outcome.RevisionID, "baseline-worker"))
	if err != nil {
		return "", err
	}
	if publication.State != v2publish.IntentFinalized {
		return "", fmt.Errorf("baseline publication state = %s", publication.State)
	}
	return outcome.RevisionID, nil
}

func runExternalReconciliation(root, apex string, result *evidence) error {
	type reconciliationInput struct {
		name     string
		kind     v2publish.ReconciliationKind
		path     string
		deleted  bool
		expected []byte
		mutate   func(string) error
	}
	for _, item := range []struct {
		name     string
		kind     v2publish.ReconciliationKind
		path     string
		deleted  bool
		expected string
		mutate   func(string) error
	}{
		{
			name: "edit", kind: v2publish.ReconcileEdit, path: "songs/Reconcile-Song.md",
			expected: "# Reconcile Song\n\nExternal edit\n",
			mutate: func(clone string) error {
				if err := writeFile(clone, "songs/Reconcile-Song.md", "# Reconcile Song\n\nExternal edit\n"); err != nil {
					return err
				}
				return mutateSidecarClaims(clone, "reconcile-song", "")
			},
		},
		{
			name: "delete", kind: v2publish.ReconcileDelete, path: "songs/Reconcile-Song.md", deleted: true,
			expected: "",
			mutate: func(clone string) error {
				if err := os.Remove(filepath.Join(clone, "songs", "Reconcile-Song.md")); err != nil {
					return err
				}
				return mutateSidecarClaims(clone, "reconcile-song", "")
			},
		},
		{
			name: "rename", kind: v2publish.ReconcileRename, path: "songs/Reconciled-Rename.md",
			expected: "# Reconcile Song\n\nPublished body\n",
			mutate: func(clone string) error {
				if err := gitRun(clone, "mv", "songs/Reconcile-Song.md", "songs/Reconciled-Rename.md"); err != nil {
					return err
				}
				return mutateSidecarClaims(clone, "reconcile-song", "songs/Reconciled-Rename.md")
			},
		},
	} {
		input := reconciliationInput{
			name: item.name, kind: item.kind, path: item.path, deleted: item.deleted,
			expected: []byte(item.expected), mutate: item.mutate,
		}
		h, err := newHarness(root, "reconciliation-"+input.name, apex, v2publish.Hooks{})
		if err != nil {
			return err
		}
		baselineRevision, err := publishBaseline(h, "reconciliation-baseline", "reconcile-song", "Reconcile Song", "songs/Reconcile-Song.md")
		if err != nil {
			_ = h.close()
			return err
		}
		if _, err := applyRevision(h.store, "reconciliation-local", "reconcile-song", "Reconcile Song", baselineRevision, leadPayload("songs/Reconcile-Song.md", "Reconcile Song", "Unpublished local edit")); err != nil {
			_ = h.close()
			return err
		}
		if _, err := externalCommit(h.root, h.remote, input.name, input.mutate); err != nil {
			_ = h.close()
			return err
		}
		records, err := h.publisher.Reconcile(context.Background(), v2publish.ReconcileRequest{
			OwnerID: ownerID, DeviceID: deviceID, Holder: "reconciliation-worker", Actor: "operator",
		})
		if err != nil || len(records) != 1 {
			_ = h.close()
			return fmt.Errorf("reconcile %s: records=%d err=%w", input.name, len(records), err)
		}
		record := records[0]
		stored, err := h.publisher.Ledger().Reconciliation(record.ConflictID)
		if err != nil {
			_ = h.close()
			return err
		}
		claimsIgnored := record.CandidateRevisionID != "rev-ffffffffffffffffffffffff" && record.CandidateSourceSHA256 != strings.Repeat("0", 64)
		preserved := record.Kind == input.kind && record.CandidatePath == input.path && record.CandidateDeleted == input.deleted && bytes.Equal(record.CandidateSource, input.expected) && bytes.Equal(stored.CandidateSource, input.expected) && stored.CandidateRevisionID == record.CandidateRevisionID
		if err := require(preserved && claimsIgnored && record.Status == "open", input.name+" external candidate was not durably preserved"); err != nil {
			_ = h.close()
			return err
		}
		again, err := h.publisher.Reconcile(context.Background(), v2publish.ReconcileRequest{
			OwnerID: ownerID, DeviceID: deviceID, Holder: "reconciliation-worker", Actor: "operator",
		})
		if err != nil || len(again) != 0 {
			_ = h.close()
			return fmt.Errorf("repeated reconcile %s: records=%d err=%w", input.name, len(again), err)
		}
		result.ExternalReconciliation.Cases = append(result.ExternalReconciliation.Cases, reconciliationCase{
			Case: input.name, Kind: string(record.Kind), CandidatePath: record.CandidatePath,
			CandidateDeleted: record.CandidateDeleted, CandidateBytes: len(record.CandidateSource),
			CandidatePreserved: preserved, SidecarClaimsIgnored: claimsIgnored,
			Status: record.Status, RepeatedScanIdempotent: true,
		})
		if err := h.close(); err != nil {
			return err
		}
	}
	return nil
}

func runUnownedAddition(root, apex string, result *evidence) error {
	h, err := newHarness(root, "unowned-addition", apex, v2publish.Hooks{})
	if err != nil {
		return err
	}
	defer h.close()
	baselineRevision, err := publishBaseline(h, "unowned-baseline", "owned-song", "Owned Song", "songs/Owned-Song.md")
	if err != nil {
		return err
	}
	baseBefore, initialized, err := h.publisher.Ledger().GitBase()
	if err != nil || !initialized {
		return fmt.Errorf("read initialized base: %w", err)
	}
	candidate := []byte("# Unowned Song\n\nExternal addition\n")
	if _, err := externalCommit(h.root, h.remote, "unowned", func(clone string) error {
		return writeFile(clone, "songs/Unowned-Song.md", string(candidate))
	}); err != nil {
		return err
	}
	records, reconcileErr := h.publisher.Reconcile(context.Background(), v2publish.ReconcileRequest{
		OwnerID: ownerID, DeviceID: deviceID, Holder: "unowned-worker", Actor: "operator",
	})
	if err := require(v2publish.IsCode(reconcileErr, v2publish.CodeReconciliation) && len(records) == 0, "unowned addition did not fail reconciliation closed"); err != nil {
		return err
	}
	baseAfter, _, err := h.publisher.Ledger().GitBase()
	if err != nil {
		return err
	}
	additions, err := h.publisher.Ledger().UnownedAdditions(ownerID)
	if err != nil {
		return err
	}
	preserved := len(additions) == 1 && additions[0].Path == "songs/Unowned-Song.md" && bytes.Equal(additions[0].Source, candidate) && additions[0].Status == "open"
	if err := require(baseAfter == baseBefore && preserved, "unowned addition advanced base or lost candidate bytes"); err != nil {
		return err
	}
	newer, err := applyRevision(h.store, "unowned-newer", "owned-song", "Owned Song", baselineRevision, leadPayload("songs/Owned-Song.md", "Owned Song", "New local body"))
	if err != nil {
		return err
	}
	beforeBlocked, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	blocked, blockedErr := h.publisher.Publish(context.Background(), publishRequest("owned-song", newer.RevisionID, "blocked-worker"))
	afterBlocked, err := remoteCount(h.remote)
	if err != nil {
		return err
	}
	publicationBlocked := v2publish.IsCode(blockedErr, v2publish.CodeReconciliation) && blocked.Commit == "" && afterBlocked == beforeBlocked
	if err := require(publicationBlocked, "unowned addition did not block base advancement publication"); err != nil {
		return err
	}
	result.UnownedAddition.ErrorCode = publishCode(reconcileErr)
	result.UnownedAddition.RecordCount = len(additions)
	result.UnownedAddition.CandidatePath = additions[0].Path
	result.UnownedAddition.CandidateBytes = len(additions[0].Source)
	result.UnownedAddition.CandidatePreserved = preserved
	result.UnownedAddition.BaseUnchanged = baseAfter == baseBefore
	result.UnownedAddition.PublicationBlocked = publicationBlocked
	return nil
}
