.PHONY: build test run clean migrate validate

build:
	go build -o srv/songs ./cmd/srv

test:
	go test ./...

run: build
	./srv/songs -listen :8000 -repo .

clean:
	rm -f srv/songs

migrate:
	python3 tools/migrate_legacy.py --source /home/exedev/set-lists-reference --destination .

validate: build
	go test ./...
	./srv/songs -repo . -db /tmp/songs-validate.sqlite3 -listen 127.0.0.1:0 >/dev/null 2>&1 & pid=$$!; sleep 1; kill $$pid 2>/dev/null || true
