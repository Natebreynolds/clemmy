"""Wait until the installed daemon serves the expected build (sha prefix), up to 180 s."""
import json, os, sys, time, urllib.request
HOME = os.path.expanduser('~/.clementine-next')
TOKEN = next(l.split('=', 1)[1].strip().strip('"') for l in open(os.path.join(HOME, '.env')) if l.startswith('WEBHOOK_SECRET='))
want, deadline = sys.argv[1], time.time() + 180
while time.time() < deadline:
    try:
        req = urllib.request.Request('http://127.0.0.1:8520/api/console/build-info', headers={'Authorization': f'Bearer {TOKEN}'})
        sha = json.loads(urllib.request.urlopen(req, timeout=5).read()).get('gitSha', '')
        if sha.startswith(want):
            print('serving', sha[:12]); sys.exit(0)
    except Exception:
        pass
    time.sleep(3)
sys.exit(f'build {want} not serving after 180 s')
