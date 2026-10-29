#!/usr/bin/env python3
"""Summarise ParkPlay `player stats` beacons from the server journal.

usage:
  ssh <host> 'sudo journalctl -u parkplay-web --no-pager -o short-iso --since "-2 days"' \
    | python3 tools/beacon-summary.py [--since 2026-10-29]

Groups the windows recorded while playing by (quality, fps, hw) and prints the average of each
per-window field."""
import json
import re
import sys
from collections import defaultdict

since = sys.argv[sys.argv.index('--since') + 1] if '--since' in sys.argv else None
rows = []
for line in sys.stdin:
    if 'player stats' not in line:
        continue
    ts = line[:19]
    if since and ts < since:
        continue
    m = re.search(r'(\{.*\})\s*$', line)
    if not m:
        continue
    try:
        rows.append((ts, json.loads(m.group(1))))
    except json.JSONDecodeError:
        continue

groups = defaultdict(list)
for ts, s in rows:
    if s.get('state') == 'playing':
        groups[(s.get('q'), s.get('fps'), s.get('hw'))].append(s.get('win') or {})

FIELDS = ['drawn', 'dropped', 'dropPct', 'rafHz', 'drawMsAvg', 'rafGapMax', 'late', 'vqMax',
          'stalls', 'kbps', 'clockStepMs', 'clockHz', 'freezeMs']


def avg(ws, f):
    v = [w[f] for w in ws if isinstance(w.get(f), (int, float))]
    return round(sum(v) / len(v), 1) if v else '-'


print(f'{len(rows)} beacons, {sum(len(v) for v in groups.values())} playing windows'
      + (f' since {since}' if since else ''))
print('q fps hw windows ' + ' '.join(FIELDS))
for key, ws in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    print(*key, len(ws), *[avg(ws, f) for f in FIELDS])
with_clock = [r for r in rows if (r[1].get('win') or {}).get('clockStepMs') is not None]
if with_clock:
    print(f'clockStepMs present in {len(with_clock)} beacons (first {with_clock[0][0]})')
