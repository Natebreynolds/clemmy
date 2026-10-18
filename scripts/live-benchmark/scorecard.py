"""Scorecard for one benchmark arm: outcome, wall time and tokens per leg.

usage: python3 -I scorecard.py <arm-output-dir> <arm-label>
Reads the drive_turn.py logs in the directory and the app's own usage ledger,
prints a table, and writes scorecard.json beside the logs.
"""
import json, os, re, sqlite3, sys

out_dir, arm = sys.argv[1], sys.argv[2]
db = sqlite3.connect(f"file:{os.path.expanduser('~/.clementine-next/state/harness.db')}?mode=ro", uri=True, timeout=10)
scenarios, totals = [], {}
for name in sorted(n for n in os.listdir(out_dir) if re.fullmatch(r's\d+\.log', n)):
    text = open(os.path.join(out_dir, name)).read()
    head = text.split('\n', 1)[0].split()
    if len(head) < 4 or head[0] != 'SESSION':
        scenarios.append({'scenario': name[:-4], 'outcome': 'not_started'})
        continue
    sid, seq = head[1], int(head[3])
    done = re.search(r'DONE status=(\S+)', text)
    wall = re.search(r'WALL ([\d.]+)', text)
    legs = {}
    for role, calls, prompt, cached, output in db.execute(
            'select role,sum(calls),sum(prompt_tokens),sum(cached_tokens),sum(output_tokens) from accepted_source_usage_v1 '
            'where session_id=? and source_user_seq>=? group by role', (sid, seq)):
        legs[role] = {'calls': calls or 0, 'prompt': prompt or 0, 'cached': cached or 0,
                      'uncached': (prompt or 0) - (cached or 0), 'output': output or 0}
        t = totals.setdefault(role, {'calls': 0, 'prompt': 0, 'cached': 0, 'uncached': 0, 'output': 0})
        for k in t: t[k] += legs[role][k]
    reviews = [json.loads(d).get('fulfills') for (d,) in db.execute(
        "select data_json from events where session_id=? and seq>=? and type='goal_alignment_judged'", (sid, seq))]
    scenarios.append({'scenario': name[:-4], 'session': sid, 'outcome': done.group(1) if done else 'unfinished',
                      'wallSeconds': float(wall.group(1)) if wall else None, 'legs': legs, 'reviews': reviews})

card = {'arm': arm, 'scenarios': scenarios, 'totals': totals,
        'done': sum(1 for s in scenarios if s.get('outcome') == 'done'),
        'wallSeconds': round(sum(s.get('wallSeconds') or 0 for s in scenarios), 1)}
json.dump(card, open(os.path.join(out_dir, 'scorecard.json'), 'w'), indent=2)
print(f"== {arm}: {card['done']}/{len(scenarios)} done, {card['wallSeconds']} s")
for s in scenarios:
    print(f"  {s['scenario']} {s.get('outcome'):<11} {s.get('wallSeconds') or 0:6.0f}s reviews {s.get('reviews')}")
for role, t in sorted(totals.items(), key=lambda kv: -kv[1]['prompt']):
    share = t['cached'] / max(t['prompt'], 1)
    print(f"  {role:<9} calls {t['calls']:>3} prompt {t['prompt']/1e3:7.0f}k cached {share:4.0%} uncached {t['uncached']/1e3:6.0f}k out {t['output']/1e3:5.1f}k")
