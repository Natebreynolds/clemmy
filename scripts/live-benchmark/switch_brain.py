"""Switch Clem's brain through the app's own Settings route, then show the routing keys.
usage: python3 -I switch_brain.py claude_oauth claude-opus-5-5 | api_key deepseek-ai/DeepSeek-V4.1-Flash"""
import json, os, sys, urllib.request
HOME = os.path.expanduser('~/.clementine-next')
TOKEN = next(l.split('=', 1)[1].strip().strip('"') for l in open(os.path.join(HOME, '.env')) if l.startswith('WEBHOOK_SECRET='))
brain, model = sys.argv[1], sys.argv[2]
req = urllib.request.Request('http://127.0.0.1:8520/api/console/settings/active-brain', method='PATCH',
    data=json.dumps({'brain': brain, 'modelId': model}).encode(),
    headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
try:
    body = json.loads(urllib.request.urlopen(req, timeout=60).read())
    print('ok', body.get('ok'), 'activeBrain', body.get('activeBrain'), 'effective', body.get('effectiveValue'), 'brain', json.dumps(body.get('brain'))[:200])
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read()[:400]); sys.exit(1)
keys = ('AUTH_MODE', 'BYO_BRAIN_MODEL_ID', 'MODEL_ROUTING_MODE', 'OPENAI_MODEL_WORKER', 'CLAUDE_MODEL', 'CLEMMY_MODEL_ROLES')
for line in open(os.path.join(HOME, '.env')):
    if line.split('=', 1)[0] in keys: print(' ', line.strip()[:300])
