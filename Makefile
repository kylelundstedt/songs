.PHONY: build test run clean migrate validate smoke deploy restore-drill

build:
	go build -o srv/songs ./cmd/srv

test:
	go test ./...
	node srv/static/sw_test.js

run: build
	./srv/songs -listen :8000 -repo .

clean:
	rm -f srv/songs

migrate:
	python3 tools/migrate_legacy.py --source /home/exedev/set-lists-reference --destination .

validate: build
	go test ./...
	./srv/songs -repo . -db /tmp/songs-validate.sqlite3 -listen 127.0.0.1:0 >/dev/null 2>&1 & pid=$$!; sleep 1; kill $$pid 2>/dev/null || true

smoke:
	./scripts/smoke-test.sh

deploy:
	./scripts/deploy-v1.sh

restore-drill:
	./scripts/restore-drill.sh
