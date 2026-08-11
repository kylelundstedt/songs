.PHONY: build test run clean migrate validate v2-check v2-api-build v2-api-run

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

v2-api-build:
	go build -o srv/songs-v2-api ./cmd/v2api

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
