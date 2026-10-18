"""Per-turn report: usage by role, completion reviews, failed tool calls."""
import json, os, re, sqlite3, sys
first = open(sys.argv[1]).readline().split(); sid, seq = first[1], int(first[3])
db = sqlite3.connect(f"file:{os.path.expanduser('~/.clementine-next/state/harness.db')}?mode=ro", uri=True, timeout=10)
for role, calls, p, c, o, ms in db.execute("select role,sum(calls),sum(prompt_tokens),sum(cached_tokens),sum(output_tokens),sum(model_ms) from accepted_source_usage_v1 where session_id=? and source_user_seq>=? group by role order by 3 desc", (sid, seq)):
    print(f"  {role:<9} calls {calls:>3} prompt {p/1e3:6.0f}k cached {(c or 0)/max(p,1):4.0%} out {(o or 0)/1e3:5.1f}k model {(ms or 0)/1e3:5.0f}s")
v = [json.loads(d).get('fulfills') for (d,) in db.execute("select data_json from events where session_id=? and seq>=? and type='goal_alignment_judged'", (sid, seq))]
print(f"  completion reviews {len(v)} verdicts {v}")
fails = []
for (d,) in db.execute("select data_json from events where session_id=? and seq>=? and type='tool_returned' and json_extract(data_json,'$.accounting')='top_level'", (sid, seq)):
    j = json.loads(d); r = j.get('result'); r = r if isinstance(r, str) else json.dumps(r)
    if j.get('ok') is False or re.search(r'"error":"|refused before|not valid JSON|Unrecognized key|Invalid replacement', (r or '')[:400]):
        fails.append(f"{j.get('effectiveTool') or j.get('tool')}: {(r or '')[:140]}")
print(f"  failed tool calls {len(fails)}")
for f in fails[:6]: print('   -', f.replace('\n', ' '))
