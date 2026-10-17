#!/usr/bin/env python3
"""정책 산술만 검증한다. DB 권한·동시성·실제 지급을 검증하는 도구가 아니다."""
import argparse
import json
from pathlib import Path


def integer(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field}: 0 이상의 정수 필요")
    return value


def calculate(data):
    life = data['lifestyle']
    unit = integer(life['unit'], 'unit')
    limit = integer(life['limit'], 'limit')
    events = integer(life['confirmed_events'], 'confirmed_events')
    school = data['school']
    count = integer(school['stickers'], 'stickers')
    issued = integer(school['issued'], 'issued')
    executed = integer(school['executed'], 'executed')
    if not isinstance(school['confirmed'], bool):
        raise ValueError('confirmed: 명시적 boolean 필요')
    target = None if not school['confirmed'] else 15000 if count >= 8 else 10000 if count >= 5 else 0
    return {
        'scope': 'ARITHMETIC_ONLY',
        'lifestyle': {
            'source_events': events,
            'recognized': min(events, limit),
            'quantity': min(events, limit) * unit,
            'exceeded': max(0, events - limit),
        },
        'school': {
            'target': target,
            'additional_right': None if target is None else max(0, target - issued),
            'outstanding_execution': max(0, issued - executed),
            'review_required': False if target is None else issued > target or executed > target,
            'can_finalize': target is not None and issued <= target and executed <= target,
        },
    }


def self_test():
    sample = {'lifestyle': {'unit': 15, 'limit': 3, 'confirmed_events': 4},
              'school': {'stickers': 8, 'confirmed': True, 'issued': 10000, 'executed': 10000}}
    result = calculate(sample)
    assert result['lifestyle']['quantity'] == 45
    assert result['school']['additional_right'] == 5000
    assert result['school']['outstanding_execution'] == 0
    for count, target in [(4, 0), (5, 10000), (7, 10000), (8, 15000)]:
        sample['school'].update(stickers=count, issued=0, executed=0)
        assert calculate(sample)['school']['target'] == target
    sample['school']['confirmed'] = False
    assert calculate(sample)['school']['target'] is None
    sample['school'].update(confirmed=True, stickers=5, issued=15000, executed=15000)
    assert calculate(sample)['school']['review_required'] is True
    print('정책 산술 확인 완료 — DB/동시성/지급 시험 아님')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', nargs='?', help='정책 산술 JSON 파일')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.input:
        print(json.dumps(calculate(json.loads(Path(args.input).read_text())), ensure_ascii=False, indent=2))
    else:
        parser.error('입력 파일 또는 --self-test 필요')
