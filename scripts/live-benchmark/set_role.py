"""Bind a model role through the app's Settings route. usage: set_role.py judge claude-opus-5-5"""
import json, os, sys, urllib.request
HOME = os.path.expanduser('~/.clementine-next')
TOKEN = next(l.split('=', 1)[1].strip().strip('"') for l in open(os.path.join(HOME, '.env')) if l.startswith('WEBHOOK_SECRET='))
req = urllib.request.Request('http://127.0.0.1:8520/api/console/settings/models/roles', method='PATCH',
    data=json.dumps({'role': sys.argv[1], 'modelId': sys.argv[2]}).encode(),
    headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
try:
    body = json.loads(urllib.request.urlopen(req, timeout=60).read())
    print('ok', json.dumps(body.get('modelRoles'))[:500])
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read()[:400]); sys.exit(1)
