# Current route evidence and policy

`route-baseline.json` builds/runs the exact frozen server on loopback with an
isolated SQLite database. It records all 27 registered routes and 1,198 safe
requests, including 1,153 canonical document requests.

`route-policy.json` covers every registration with one explicit decision:
12 preserve, 1 redirect, 1 retire, and 13 defer. During parallel operation all
legacy routes remain on v1; redirects are not activated before cutover approval.
Directory listing, arbitrary root fallback, and authoring controls in Live are
retired edge behaviors rather than parity requirements.

```sh
python3 scripts/build_v2_current_route_baseline.py --check
python3 scripts/build_v2_current_contracts.py --check
```
