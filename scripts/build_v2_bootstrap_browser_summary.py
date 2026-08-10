#!/usr/bin/env python3
"""Validate recorded TASK-006 browser observations; never regenerate runtime data."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

BASELINE_REF = 'v1'
BASELINE_COMMIT = '546f59b41d9e9bcf0e81b543c27900a31e26c9e6'
SCHEMA_VERSION = '1'
DOCUMENTS = 351
SOURCE_BYTES = 743078
REQUIRE_EVIDENCE_BINDING = False
HEADROOM_MULTIPLIER = 10
BASELINE = Path('migration/v2/bootstrap/bootstrap-baseline.json')
RAW = Path('migration/v2/bootstrap/browser-observations')
OUTPUT = Path('migration/v2/bootstrap/browser-summary.json')
PROFILES = (('ipad-portrait', 1024, 1366, 'tablet'), ('ipad-landscape', 1366, 1024, 'tablet'), ('phone', 390, 844, 'phone'))
BASE_STORES = ['chunks', 'documents', 'drafts', 'meta', 'outbox', 'snapshots']
V2_STORES = ['chunks', 'conflicts', 'documents', 'drafts', 'meta', 'outbox', 'snapshots']
REQUIRED_PROOFS = (
    'schema_upgrade', 'interruption_failure', 'checksum_failure', 'previous_active_survived_failures',
    'active_pointer_survived_failures', 'pending_writes_preserved', 'conflict_preserved',
    'activation_pointer_transition_exactly_one', 'single_active_snapshot_and_pointer_authority',
    'idempotent_retry', 'all_documents_readable', 'orphan_cleanup', 'service_worker',
)

def sha(raw: bytes) -> str: return hashlib.sha256(raw).hexdigest()
def canonical(value: Any) -> bytes: return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()
def fail(message: str) -> None: raise ValueError(message)
def load(path: Path) -> dict[str, Any]:
    try: value = json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc: fail(f'unable to read {path}: {exc}')
    if not isinstance(value, dict): fail(f'{path}: JSON object required')
    return value
def nonnegative(value: Any, name: str, path: Path) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0: fail(f'{path}: {name} must be a nonnegative number')
def stores(value: Any) -> list[str]: return sorted(value) if isinstance(value, list) and all(isinstance(x, str) for x in value) else []
def scenario_consistent(data: dict[str, Any], path: Path) -> None:
    scenario = data.get('scenario')
    if not isinstance(scenario, dict) or not isinstance(scenario.get('schema'), dict) or not isinstance(scenario.get('stages'), dict): fail(f'{path}: captured scenario details required')
    seeded, upgraded = scenario['schema'].get('seeded'), scenario['schema'].get('upgraded')
    if not isinstance(seeded, dict) or seeded.get('version') != 1 or stores(seeded.get('stores')) != BASE_STORES: fail(f'{path}: captured v1 schema is not the exact base store set')
    if not isinstance(upgraded, dict) or upgraded.get('version') != 2 or stores(upgraded.get('stores')) != V2_STORES: fail(f'{path}: captured v2 schema upgrade is invalid')
    stages = scenario['stages']
    for name in ('interrupted', 'corrupt', 'success', 'idempotent_retry', 'after_interrupted', 'after_corrupt', 'after_success', 'after_idempotent_retry'):
        if not isinstance(stages.get(name), dict): fail(f'{path}: missing captured scenario result {name}')
    if stages['interrupted'].get('failure') != 'interrupted' or stages['corrupt'].get('failure') != 'chunk-checksum' or stages['success'].get('activated') is not True: fail(f'{path}: captured stage outcomes are invalid')
    if stages['idempotent_retry'].get('idempotent') is not True or stages['idempotent_retry'].get('activated') is not True: fail(f'{path}: captured retry is not idempotent')
    for name in ('after_interrupted', 'after_corrupt'):
        inspection = stages[name]
        legacy = inspection.get('legacy_document')
        if inspection.get('active_generation') != 'old-v1' or inspection.get('pointer_transitions') != 0: fail(f'{path}: active pointer did not survive {name}')
        if not isinstance(legacy, dict) or legacy.get('content_matches_record') is not True or legacy.get('sha256') != legacy.get('content_sha256'): fail(f'{path}: old active bytes/hash did not survive {name}')
    success, retry = stages['after_success'], stages['after_idempotent_retry']
    active = [x for x in success.get('snapshots', []) if isinstance(x, dict) and x.get('state') == 'active']
    if len(active) != 1 or active[0].get('generation') != data.get('generation') or success.get('active_generation') != data.get('generation'): fail(f'{path}: active snapshot/pointer authority is invalid')
    if not any(x.get('generation') == 'old-v1' and x.get('state') == 'retained' for x in success.get('snapshots', []) if isinstance(x, dict)): fail(f'{path}: previous snapshot was not retained')
    if success.get('pointer_transitions') != 1 or retry.get('pointer_transitions') != 1: fail(f'{path}: retry caused another pointer transition')
    if retry.get('documents_by_generation', {}).get(data.get('generation')) != success.get('documents_by_generation', {}).get(data.get('generation')): fail(f'{path}: idempotent retry changed active documents')
    verification = scenario.get('document_verification')
    if not isinstance(verification, dict) or verification.get('count') != DOCUMENTS or verification.get('hashes_valid') is not True or verification.get('snapshot_digest') != verification.get('expected_snapshot_digest'): fail(f'{path}: captured document verification is invalid')

def validate(path: Path, expected: tuple[str, int, int, str], baseline: dict[str, Any], identity: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    name, width, height, form_factor = expected
    data = load(path)
    if data.get('schema_version') != SCHEMA_VERSION: fail(f'{path}: schema_version must be {SCHEMA_VERSION}')
    if data.get('baseline') != {'ref': BASELINE_REF, 'commit': BASELINE_COMMIT}: fail(f'{path}: exact baseline required')
    if data.get('generation') != baseline['generation']: fail(f'{path}: generation differs from deterministic payload')
    if REQUIRE_EVIDENCE_BINDING:
        expected_binding = {
            'bootstrap_baseline_output_sha256': baseline['verification']['output_sha256'],
            'payload_manifest_sha256': baseline['payload']['manifest_sha256'],
            'harness_assets': baseline['assets'],
            'harness_source_commit': baseline['harness_source']['commit'],
        }
        if data.get('evidence_binding') != expected_binding:
            fail(f'{path}: observation is not bound to the exact bootstrap baseline/harness')
    requested = {'width': width, 'height': height, 'device_scale_factor': 1, 'mobile': name == 'phone', 'touch': True}
    profile = data.get('profile')
    if not isinstance(profile, dict) or profile.get('name') != name or profile.get('requested') != requested: fail(f'{path}: requested profile does not match {name}')
    observed = profile.get('observed')
    if not isinstance(observed, dict) or observed.get('inner_width') != width or observed.get('inner_height') != height or observed.get('device_pixel_ratio') != 1 or observed.get('form_factor') != form_factor or observed.get('max_touch_points', 0) < 1: fail(f'{path}: observed viewport, DPR, or touch profile does not match')
    engine = data.get('browser_engine')
    if not isinstance(engine, dict) or not all(isinstance(engine.get(key), str) and engine[key] for key in ('name', 'user_agent', 'platform')): fail(f'{path}: browser engine identity required')
    if identity is not None and engine != identity: fail(f'{path}: browser engine identity differs across captures')
    proof = data.get('scenario_proof')
    if not isinstance(proof, dict) or any(proof.get(key) is not True for key in REQUIRED_PROOFS): fail(f'{path}: scenario proof is incomplete or false')
    scenario_consistent(data, path)
    if data.get('documents') != DOCUMENTS or data.get('source_bytes') != SOURCE_BYTES: fail(f'{path}: corpus result must be {DOCUMENTS} documents / {SOURCE_BYTES} bytes')
    durations = data.get('durations_ms')
    if not isinstance(durations, dict): fail(f'{path}: durations_ms required')
    for key in ('interrupted', 'corrupt', 'success', 'idempotent_retry'): nonnegative(durations.get(key), f'durations_ms.{key}', path)
    storage = data.get('storage')
    if not isinstance(storage, dict) or not isinstance(storage.get('before'), dict) or not isinstance(storage.get('after'), dict): fail(f'{path}: storage before/after required')
    for phase in ('before', 'after'):
        for key in ('usage', 'quota'): nonnegative(storage[phase].get(key), f'storage.{phase}.{key}', path)
        if storage[phase]['quota'] < storage[phase]['usage']: fail(f'{path}: {phase} quota below usage')
    after_headroom = storage['after']['quota'] - storage['after']['usage']
    if after_headroom < HEADROOM_MULTIPLIER * SOURCE_BYTES: fail(f'{path}: after storage headroom must be at least {HEADROOM_MULTIPLIER}x source bytes')
    sw = data.get('service_worker')
    if not isinstance(sw, dict) or sw.get('supported') is not True or sw.get('registered') is not True or not isinstance(sw.get('expected_cache_name'), str) or not sw['expected_cache_name'] or sw.get('cache_name') != sw['expected_cache_name'] or sw.get('cache_matches_expected') is not True: fail(f'{path}: expected versioned service-worker cache was not registered')
    record = {'profile': name, 'path': path.name, 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size}
    quota = {'before': storage['before'], 'after': storage['after'], 'usage_delta': storage['after']['usage'] - storage['before']['usage'], 'after_headroom': after_headroom, 'after_headroom_source_bytes_ratio': after_headroom / SOURCE_BYTES}
    summary = {'name': name, 'requested': requested, 'observed': observed, 'durations_ms': durations, 'storage': quota, 'service_worker': sw, 'logical_outcome': {key: proof[key] for key in REQUIRED_PROOFS}}
    return record, summary

def build(repo: Path, raw: Path = RAW) -> bytes:
    baseline = load(repo / BASELINE)
    if baseline.get('baseline') != {'ref': BASELINE_REF, 'commit': BASELINE_COMMIT}: fail('bootstrap baseline is not exact required baseline')
    records, profiles, identity = [], [], None
    for expected in PROFILES:
        path = raw / f'{expected[0]}.json'
        if not path.is_file(): fail(f'missing recorded observation: {path} (record it with the harness server)')
        record, profile = validate(path, expected, baseline, identity)
        records.append(record); profiles.append(profile); identity = load(path)['browser_engine']
    values = [profile['durations_ms'][key] for profile in profiles for key in profile['durations_ms']]
    result = {
        'schema_version': SCHEMA_VERSION, 'baseline': baseline['baseline'], 'generation': baseline['generation'], 'captures': records,
        'browser_engine': identity, 'profiles': profiles,
        'timing_ms': {'minimum': min(values), 'maximum': max(values), 'values_by_profile': {profile['name']: profile['durations_ms'] for profile in profiles}},
        'storage_quota': {profile['name']: profile['storage'] for profile in profiles},
        'storage_note': 'usage and quota are origin-wide browser estimates. Raw before/after values and deltas are recorded observations; they do not isolate this IndexedDB database or profile from prior same-origin data.',
        'physical_safari_ipad': {'status': 'pending', 'note': 'Chromium emulation and these captures do not prove physical Safari/iPad quota, eviction, persistence, or background-suspension behavior.'},
        'verification': {'output_sha256': None},
    }
    if REQUIRE_EVIDENCE_BINDING:
        result['bootstrap_evidence_binding'] = {
            'bootstrap_baseline_output_sha256': baseline['verification']['output_sha256'],
            'payload_manifest_sha256': baseline['payload']['manifest_sha256'],
            'harness_assets': baseline['assets'],
            'harness_source_commit': baseline['harness_source']['commit'],
        }
    result['verification']['output_sha256'] = sha(canonical(result))
    return canonical(result)

def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true'); parser.add_argument('--raw-dir', type=Path); parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv); repo = Path(__file__).resolve().parents[1]; raw = args.raw_dir or repo / RAW; output = args.output or repo / OUTPUT
    try: generated = build(repo, raw)
    except ValueError as exc: print(f'browser observations unavailable or invalid: {exc}', file=sys.stderr); return 1
    if args.check:
        if not output.is_file() or output.read_bytes() != generated: print(f'{output}: generated summary differs', file=sys.stderr); return 1
        print(f'{output}: OK'); return 0
    output.parent.mkdir(parents=True, exist_ok=True); output.write_bytes(generated); print(f'wrote {output}'); return 0
if __name__ == '__main__': raise SystemExit(main())
