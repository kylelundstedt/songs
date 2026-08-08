# V1 route baseline

`route-baseline.json` is generated from a fresh `git archive v1` export at
`546f59b41d9e9bcf0e81b543c27900a31e26c9e6`. It builds and runs the tagged Go
server with an isolated SQLite database on an ephemeral loopback port, captures
canonical read-route responses and safe edge probes, and records explicit
mutation/provider exclusions. Redirects are not followed. Body evidence is
stored compactly as byte counts and normalized SHA-256 values. Tagged archive
file mtimes are preserved. Only RFC3339 operational/build timestamps, the
generated temporary Shelley URL, and the ephemeral loopback port are normalized.
`Date`, `Content-Length`, and `Last-Modified` are ignored.

The baseline records 1,158 requests, including 1,113 canonical corpus requests.
Notable v1 behavior includes case-sensitive IDs, encoded `1979` resolving,
trailing-slash document routes returning 404, duplicate slashes being cleaned
with a 307, and `/static` redirecting to a browsable `/static/` directory.
Authenticated mutations and valid provider/LLM calls are explicitly excluded;
only safe unauthenticated or validation-boundary probes are executed.

```sh
python3 scripts/build_v2_route_baseline.py
python3 scripts/build_v2_route_baseline.py --check
```
