"""Send one owner request to Clem (normal learning) and follow it until it needs the
owner or finishes. Read-only after the one chat request.

Usage: python3 -I drive_turn.py <sha-prefix> "<prompt>" [session-id-to-continue]
Prints each tool call, card, question and the final reply, plus usage for the turn.
"""
import json, os, sqlite3, sys, time, urllib.request, uuid

HOME = os.path.expanduser('~/.clementine-next')
TOKEN = next(l.split('=', 1)[1].strip().strip('"') for l in open(os.path.join(HOME, '.env')) if l.startswith('WEBHOOK_SECRET='))


def http(route, body=None, timeout=60):
    req = urllib.request.Request('http://127.0.0.1:8520' + route, method='POST' if body is not None else 'GET',
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'null')


sha, prompt = sys.argv[1], sys.argv[2]
cont = sys.argv[3] if len(sys.argv) > 3 else None
info = http('/api/console/build-info')
if not str(info.get('gitSha', '')).startswith(sha):
    sys.exit(f"serving {info.get('gitSha')} not {sha}")
rid = str(uuid.uuid4())
http('/api/harness/chat', {'input': prompt, 'attachments': [], 'clientRequestId': rid,
                           **({'sessionId': cont} if cont else {})})
db = sqlite3.connect(f"file:{HOME}/state/harness.db?mode=ro", uri=True, timeout=10)
sid = None
for _ in range(150):
    row = db.execute('SELECT session_id FROM harness_chat_requests WHERE request_id=?', (rid,)).fetchone()
    if row:
        sid = row[0]
        break
    time.sleep(0.2)
seq = db.execute("SELECT seq FROM events WHERE session_id=? AND type='user_input_received' ORDER BY seq DESC LIMIT 1", (sid,)).fetchone()[0]
print('SESSION', sid, 'SOURCE', seq, 'REQUEST', rid, flush=True)
t0 = time.time()
last = seq
done = False
PROMPT_CAP = 250_000
WALL_CAP = 1500
stopped = False


def stop_turn():
    row = db.execute("SELECT json_extract(data_json,'$.runAttemptId') FROM events WHERE session_id=? AND json_extract(data_json,'$.runAttemptId') IS NOT NULL ORDER BY seq DESC LIMIT 1", (sid,)).fetchone()
    if row and row[0]:
        try:
            print('  STOP', http(f'/api/console/harness-sessions/{sid}/cancel', {'attemptId': row[0]}), flush=True)
        except Exception as e:
            print('  STOP failed', e, flush=True)

while time.time() - t0 < 3000 and not done:
    for s, typ, dj in db.execute("SELECT seq, type, data_json FROM events WHERE session_id=? AND seq>? ORDER BY seq", (sid, last)).fetchall():
        last = s
        d = json.loads(dj)
        if typ == 'tool_called' and d.get('tool') not in ('call_tool', 'work_call'):
            args = d.get('args') or d.get('input') or {}
            print(f"  {round(time.time()-t0):4}s CALL {d.get('tool')} {json.dumps(args)[:220]}", flush=True)
        elif typ == 'approval_requested':
            p = d.get('preview') or {}
            print(f"  {round(time.time()-t0):4}s CARD {d.get('approvalId')} subject={d.get('subject')} ask={p.get('ask')} why={str(p.get('why'))[:200]} fields={json.dumps(p.get('fields'))[:400]}", flush=True)
        elif typ == 'guardrail_tripped' and d.get('kind') == 'no_dispatch_step':
            print(f"  {round(time.time()-t0):4}s REFUSED-STEP streak={d.get('streak')} calls={[c.get('name') for c in d.get('calls') or []]} why={str(d.get('refusalDetail'))[:400]!r}", flush=True)
        elif typ == 'prompt_composition':
            tok = d.get('totalTokens') or 0
            if tok > PROMPT_CAP and not stopped:
                print(f"  {round(time.time()-t0):4}s WATCHDOG prompt {tok} > {PROMPT_CAP}: stopping", flush=True)
                stop_turn(); stopped = True
        elif typ == 'awaiting_user_input':
            print(f"  {round(time.time()-t0):4}s QUESTION {json.dumps(d)[:500]}", flush=True)
        elif typ == 'conversation_completed':
            p = d.get('presentation') or {}
            ident = p.get('identity') or {}
            if ident.get('sourceUserSeq') not in (None, seq):
                print(f"  {round(time.time()-t0):4}s OTHER-COMPLETION src={ident.get('sourceUserSeq')} {str(p.get('text'))[:160]!r}", flush=True)
                continue
            print(f"  {round(time.time()-t0):4}s DONE status={p.get('status')} kind={p.get('kind')}\nREPLY {p.get('text')}", flush=True)
            done = True
    if time.time() - t0 > WALL_CAP and not stopped:
        print(f"  WATCHDOG wall {WALL_CAP}s: stopping", flush=True)
        stop_turn(); stopped = True
    time.sleep(2)
u = db.execute('SELECT sum(calls),sum(prompt_tokens),sum(cached_tokens),sum(output_tokens) FROM accepted_source_usage_v1 WHERE session_id=? AND source_user_seq>=?', (sid, seq)).fetchone()
print('USAGE', {'calls': u[0], 'prompt': u[1], 'cached': u[2], 'output': u[3]}, 'WALL', round(time.time() - t0, 1))
