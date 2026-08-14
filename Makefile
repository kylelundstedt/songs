.PHONY: build test run clean migrate validate v2-check v2-browser-check p1-009-check v2-api-build v2-api-run v2-sync-check v2-publication-check v2-writable-set-list-check

build:
	go build -o srv/songs ./cmd/srv

test:
	go test ./...

v2-check:
	npm --prefix v2 run check
	npm --prefix v2 test
	npm --prefix v2 run build
	npm --prefix v2 run fixtures
	python3 scripts/build_v2_phase1_shell_evidence.py --check
	python3 scripts/build_v2_phase1_storage_evidence.py --check
	python3 scripts/build_v2_phase1_library_evidence.py --check
	python3 scripts/build_v2_phase1_live_evidence.py --check
	python3 scripts/build_v2_phase1_hardening_evidence.py --check

v2-browser-check: v2-check
	node scripts/capture_v2_phase1_hardening_evidence.mjs --check

p1-009-check: v2-browser-check
	python3 scripts/build_v2_phase1_update_drill.py --check
	python3 scripts/capture_v2_phase1_checkpoint_observation.py --check
	python3 -m unittest discover -s tests
	go test ./...
	go test -race ./internal/v2bootstrap/... ./internal/v2shell/...
	go vet ./...
	python3 scripts/build_v2_current_coexistence_summary.py --check
	python3 scripts/build_v2_phase1_checkpoint.py --check
	git diff --check

v2-api-build:
	go build -o srv/songs-v2-api ./cmd/v2api

v2-sync-check:
	go test -race ./internal/v2auth/... ./internal/v2sync/... ./internal/v2syncapi/... ./cmd/v2api
	python3 scripts/build_v2_production_sync_evidence.py --check

v2-publication-check:
	go test -race ./internal/v2publish/... ./internal/v2sync/... ./cmd/v2publisher ./cmd/v2publication-evidence
	python3 scripts/build_v2_production_publication_evidence.py --check

v2-writable-set-list-check:
	npm --prefix v2 run check --workspace @songs-v2/web
	npm --prefix v2 run test --workspace @songs-v2/web
	go test -race ./internal/v2auth/... ./internal/v2sync/... ./internal/v2syncapi/... ./internal/v2bootstrap/... ./internal/v2publish/... ./cmd/v2api ./cmd/v2publisher
	python3 scripts/build_v2_writable_set_list_evidence.py --check

v2-api-run: v2-api-build
	./srv/songs-v2-api -listen 127.0.0.1:8001

run: build
	./srv/songs -listen :8000 -repo .

clean:
	rm -f srv/songs

migrate:
	python3 tools/migrate_legacy.py --source /home/exedev/set-lists-reference --destination .

validate: build
	go test ./...
	./srv/songs -repo . -db /tmp/songs-validate.sqlite3 -listen 127.0.0.1:0 >/dev/null 2>&1 & pid=$$!; sleep 1; kill $$pid 2>/dev/null || true
