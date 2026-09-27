"""Offline consistency checks for the frozen September 27 repository trials."""
import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent
FILES = {'freeze.json', 'results.json', 'public-sources.json', 'dispatches.json'}
HEX = re.compile(r'^[0-9a-f]{64}$')


def read(name, maximum=262144):
    with (ROOT / name).open('rb') as handle:
        data = handle.read(maximum + 1)
    assert len(data) <= maximum, f'{name} exceeds the artifact limit'
    assert not any(marker in data for marker in (
        b'/Users/', b'/private/', b'/tmp/', b'TYPESAFE_API_KEY',
        b'Authorization', b'Bearer ',
    )), f'{name} contains a private-path or credential marker'
    return data


manifest = json.loads(read('manifest.json', 16384))
assert manifest['version'] == 1
assert {item['file'] for item in manifest['files']} == FILES
assert len(manifest['files']) == len(FILES)
records = {}
for item in manifest['files']:
    assert item['file'] in FILES and HEX.fullmatch(item['sha256'])
    data = read(item['file'])
    assert len(data) == item['bytes']
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    records[item['file']] = json.loads(data)

freeze, results, proof, dispatches = [records[name] for name in (
    'freeze.json', 'results.json', 'public-sources.json', 'dispatches.json',
)]
origin = manifest['source_freeze_sha256']
assert HEX.fullmatch(origin)
assert freeze['source_freeze_sha256'] == results['freeze_sha256'] == proof['freeze_sha256'] == origin
assert freeze['max_hosted_requests'] == results['cap'] == proof['max_hosted_requests'] == 40
assert freeze['max_per_repo'] == [24, 12, 4] and freeze['retries'] == 0
assert freeze['timeout_ms'] == 60000
assert freeze['route'] == results['route'] == 'typesafe/jev-1.13.0'
assert freeze['rules'] == ['core-new-empty-catch', 'core-removed-test-assertions']
assert len(freeze['cases']) == len(results['results']) == 3

allowed = set()
allowed_transport = set()
expected_sources = {}
for case in freeze['cases']:
    assert 'cwd' not in case and 'home' not in case
    assert case['repository'] in {'hraness/sys1', 'hraness/ghostget', 'hraness/design-kit'}
    assert re.fullmatch(r'[0-9a-f]{40}', case['base']) and re.fullmatch(r'[0-9a-f]{40}', case['head'])
    assert case['tracked_files'] > 100
    for request in case['requests']:
        assert HEX.fullmatch(request['request_sha256']) and HEX.fullmatch(request['transport_sha256'])
        assert HEX.fullmatch(request['state_sha256'])
        assert set(request['questions']) <= set(freeze['rules']) and request['questions']
        assert request['request_sha256'] not in allowed
        assert request['transport_sha256'] not in allowed_transport
        allowed.add(request['request_sha256'])
        allowed_transport.add(request['transport_sha256'])
    for source in case['sources']:
        assert source['commit'] in {case['base'], case['head']}
        assert not source['path'].startswith('/') and '..' not in source['path'].split('/')
        url = f"https://raw.githubusercontent.com/{case['repository']}/{source['commit']}/{source['path']}"
        assert url not in expected_sources
        expected_sources[url] = source

assert len(allowed) == len(allowed_transport) == len(dispatches) == 33
assert {item['request_sha256'] for item in dispatches} == allowed_transport
assert sorted(item['dispatch'] for item in dispatches) == list(range(1, 34))
assert results['accepted_requests'] == results['hosted_dispatches'] == 33
assert len(expected_sources) == len(proof['sources']) == 44
assert {item['url'] for item in proof['sources']} == set(expected_sources)
assert proof['model_destination'] == 'https://api.typesafe.ai/v1/systemone'
for receipt in proof['sources']:
    source = expected_sources[receipt['url']]
    assert receipt['unauthenticated'] is True
    assert receipt['sha256'] == source['sha256'] and receipt['bytes'] == source['bytes']
    if source['sha256'] is None:
        assert source['bytes'] is None and receipt['status'] == 404
    else:
        assert HEX.fullmatch(source['sha256']) and 0 < source['bytes'] <= 2097152
        assert receipt['status'] == 200
assert sum(item['status'] == 200 for item in proof['sources']) == 32
rule = proof['rule_source']
assert rule['url'] == 'https://raw.githubusercontent.com/hraness/sys1/6759898c0dae3a032015a87f1786e8ff0a232af8/packs/core/pack.yaml'
assert rule['unauthenticated'] is True and rule['status'] == 200
assert HEX.fullmatch(rule['sha256']) and 0 < rule['bytes'] <= 65536

expected = {'hraness/sys1': (16, 21, 27), 'hraness/ghostget': (4, 10, 13), 'hraness/design-kit': (2, 2, 3)}
tokens = [0, 0]
assert {item['repository'] for item in results['results']} == set(expected)
for result in results['results']:
    case = next(item for item in freeze['cases'] if item['repository'] == result['repository'])
    first, repeat = result['initial'], result['repeated']
    assert first['exit_code'] == repeat['exit_code'] == result['issues']['exit_code'] == 0
    assert first['report']['status'] == 'complete' and first['report']['complete'] is True
    assert repeat['report']['status'] == 'unchanged' and repeat['report']['complete'] is True
    assert first['report']['snapshot'] == repeat['report']['snapshot'] == case['preview']['report']['snapshot']
    assert repeat['report']['requests'] == 0 and repeat['report']['audit'] is None
    assert first['report']['findings'] == repeat['report']['findings'] == result['issues']['report']['issues'] == []
    assert first['argv'] == repeat['argv'] and result['unchanged_checkout'] is True
    audit = first['report']['audit']
    files, count, questions = expected[result['repository']]
    assert audit['changed_files'] == files and audit['questions'] == questions
    assert audit['units'] == audit['evaluated_units'] == audit['planned_requests'] == audit['requests'] == count
    assert first['report']['requests'] == len(case['requests']) == count
    assert audit['targets'] == case['preview']['report']['audit']['targets']
    assert audit['base'] == case['base'] and audit['head'] == case['head']
    assert audit['route'] == freeze['route']
    assert audit['skipped'] == audit['findings'] == [] and audit['complete'] is True
    assert [item['id'] for item in audit['rules']] == freeze['rules']
    assert audit['usage']['known_requests'] == count and audit['usage']['unknown_requests'] == 0
    tokens[0] += audit['usage']['input_tokens']
    tokens[1] += audit['usage']['output_tokens']
assert tokens == [72321, 1012]
print('Verified four bounded public records: 33 dispatches, 44 source receipts, three complete checkpoints and zero-call repeats.')
