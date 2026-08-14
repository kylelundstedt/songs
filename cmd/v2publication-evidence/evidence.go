package main

type validationCase struct {
	Case              string `json:"case"`
	ErrorCode         string `json:"error_code"`
	State             string `json:"state"`
	RemoteCommitDelta int    `json:"remote_commit_delta"`
	CommitAbsent      bool   `json:"commit_absent"`
}

type crashCase struct {
	FailurePoint               string `json:"failure_point"`
	StateAtFailure             string `json:"state_at_failure"`
	RemoteCommitDeltaAtFailure int    `json:"remote_commit_delta_at_failure"`
	FinalState                 string `json:"final_state"`
	RemoteCommitDeltaFinal     int    `json:"remote_commit_delta_final"`
	SameCommitIdentity         bool   `json:"same_commit_identity"`
	RepeatedRetryIdempotent    bool   `json:"repeated_retry_idempotent"`
}

type reconciliationCase struct {
	Case                   string `json:"case"`
	Kind                   string `json:"kind"`
	CandidatePath          string `json:"candidate_path"`
	CandidateDeleted       bool   `json:"candidate_deleted"`
	CandidateBytes         int    `json:"candidate_bytes"`
	CandidatePreserved     bool   `json:"candidate_preserved"`
	SidecarClaimsIgnored   bool   `json:"sidecar_claims_ignored"`
	Status                 string `json:"status"`
	RepeatedScanIdempotent bool   `json:"repeated_scan_idempotent"`
}

type evidence struct {
	SchemaVersion string `json:"schema_version"`
	Task          string `json:"task"`
	Execution     struct {
		TemporarySQLite          bool `json:"temporary_sqlite"`
		IsolatedBareGit          bool `json:"isolated_bare_git"`
		RealApexValidPublication bool `json:"real_apex_valid_publication"`
		CanonicalJSON            bool `json:"canonical_json"`
	} `json:"execution"`
	LeaseFencing struct {
		CrossInstanceBusyCode string `json:"cross_instance_busy_code"`
		GenerationAdvanced    bool   `json:"generation_advanced"`
		StaleFenceCode        string `json:"stale_fence_code"`
	} `json:"lease_fencing"`
	IntentBeforeGit struct {
		FailurePoint             string `json:"failure_point"`
		DurableState             string `json:"durable_state"`
		ExpectedCurrentRecorded  bool   `json:"expected_current_recorded"`
		ExpectedBaseRecorded     bool   `json:"expected_base_recorded"`
		PriorPublicationRecorded bool   `json:"prior_publication_recorded"`
		CommitAbsent             bool   `json:"commit_absent"`
		WorktreeAbsent           bool   `json:"worktree_absent"`
		RemoteCommitDelta        int    `json:"remote_commit_delta"`
	} `json:"intent_before_git"`
	Validation struct {
		Cases                 []validationCase `json:"cases"`
		ValidPublicationState string           `json:"valid_publication_state"`
		ValidRemoteDelta      int              `json:"valid_remote_commit_delta"`
		RealApexInvoked       bool             `json:"real_apex_invoked"`
	} `json:"validation"`
	ClientAcknowledgement struct {
		PublicationEventPulled bool   `json:"publication_event_pulled"`
		EventKind              string `json:"event_kind"`
		PullDidNotAcknowledge  bool   `json:"pull_did_not_acknowledge"`
		ExplicitAckAdvanced    bool   `json:"explicit_ack_advanced"`
		ReplayDidNotDuplicate  bool   `json:"replay_did_not_duplicate"`
	} `json:"client_acknowledgement"`
	DeterministicPublication struct {
		IndependentCommitIdentityEqual bool   `json:"independent_commit_identity_equal"`
		IndependentTreeIdentityEqual   bool   `json:"independent_tree_identity_equal"`
		RemoteCommitDeltaEach          int    `json:"remote_commit_delta_each"`
		FinalStateEach                 string `json:"final_state_each"`
	} `json:"deterministic_publication"`
	CrashRecovery   []crashCase `json:"crash_recovery"`
	ExpectedBaseCAS struct {
		ExternalChangeAccepted   bool   `json:"external_change_accepted"`
		InitialErrorCode         string `json:"initial_error_code"`
		StateAfterObservation    string `json:"state_after_observation"`
		PublisherDidNotOverwrite bool   `json:"publisher_did_not_overwrite"`
		RemoteCommitDelta        int    `json:"remote_commit_delta"`
	} `json:"expected_base_cas"`
	ExternalReconciliation struct {
		Cases []reconciliationCase `json:"cases"`
	} `json:"external_reconciliation"`
	UnownedAddition struct {
		ErrorCode          string `json:"error_code"`
		RecordCount        int    `json:"record_count"`
		CandidatePath      string `json:"candidate_path"`
		CandidateBytes     int    `json:"candidate_bytes"`
		CandidatePreserved bool   `json:"candidate_preserved"`
		BaseUnchanged      bool   `json:"base_unchanged"`
		PublicationBlocked bool   `json:"publication_blocked"`
	} `json:"unowned_addition"`
	BackupRestore struct {
		SyncOnlineBackup                 bool   `json:"sync_online_backup"`
		SyncBackupInsidePublicationFlock bool   `json:"sync_backup_inside_publication_flock"`
		PublicationOnlineBackup          bool   `json:"publication_online_backup"`
		GitBundleVerified                bool   `json:"git_bundle_verified"`
		BackupSkewDetected               bool   `json:"backup_skew_detected"`
		RestoredSyncEquivalent           bool   `json:"restored_sync_equivalent"`
		RestoredIntegrity                bool   `json:"restored_integrity"`
		UnfinalizedState                 string `json:"unfinalized_state"`
		RecoveredState                   string `json:"recovered_state"`
		RemoteCommitDeltaDuringRecovery  int    `json:"remote_commit_delta_during_recovery"`
		SameCommitIdentity               bool   `json:"same_commit_identity"`
	} `json:"backup_restore"`
	HandlerContinuity struct {
		V1Status          int  `json:"v1_status"`
		V2ShellStatus     int  `json:"v2_shell_status"`
		V2ManifestStatus  int  `json:"v2_manifest_status"`
		DuringBackupFlock bool `json:"during_backup_flock"`
	} `json:"handler_continuity"`
	DeploymentGuard struct {
		CheckedFile                   string `json:"checked_file"`
		EnabledDefaultFalse           bool   `json:"enabled_default_false"`
		OperationalDefaultsEmpty      bool   `json:"operational_defaults_empty"`
		DisabledConfigurationRejected bool   `json:"disabled_configuration_rejected"`
		OneShotInterface              bool   `json:"one_shot_interface"`
	} `json:"deployment_guard"`
	Acceptance struct {
		AllPassed bool `json:"all_passed"`
	} `json:"acceptance"`
}
