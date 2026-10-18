"""Remove what one benchmark arm built, so runs never pile up in the owner's home.

usage: python3 -I cleanup.py <arm-label>
- the Space titled "Shelf <arm>" is archived (recoverable from Spaces);
- workflows whose name carries "-<arm>-" are backed up under
  ~/.clementine-next/backups/live-benchmark/<arm>/ and then deleted;
- unread updates about those workflows are marked read.
Only names the benchmark itself mints match; nothing else is touched.
"""
import json, os, shutil, sys, urllib.parse, urllib.request

arm = sys.argv[1]
home = os.path.expanduser('~/.clementine-next')
token = next(l.split('=', 1)[1].strip().strip('"') for l in open(os.path.join(home, '.env')) if l.startswith('WEBHOOK_SECRET='))


def call(method, route, body=None):
    req = urllib.request.Request('http://127.0.0.1:8520' + route, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


spaces = call('GET', '/api/console/spaces')
for space in (spaces.get('spaces') if isinstance(spaces, dict) else spaces) or []:
    if space.get('title') == f'Shelf {arm}' and space.get('status') != 'archived':
        call('DELETE', f"/api/console/spaces/{urllib.parse.quote(space['id'])}")
        print('archived space', space['id'])

marker = f'-{arm.lower()}-'
backup = os.path.join(home, 'backups', 'live-benchmark', arm)
workflow_dir = os.path.join(home, 'vault', '00-System', 'workflows')
gone = []
workflows = call('GET', '/api/console/workflows')
for wf in (workflows.get('workflows') if isinstance(workflows, dict) else workflows) or []:
    name = wf.get('name', '')
    if marker not in name.lower():
        continue
    source = os.path.join(workflow_dir, name)
    if os.path.exists(source):
        os.makedirs(backup, exist_ok=True)
        if os.path.isdir(source):
            shutil.copytree(source, os.path.join(backup, name), dirs_exist_ok=True)
        else:
            shutil.copy2(source, backup)
    call('DELETE', f"/api/console/workflows/{urllib.parse.quote(name, safe='')}")
    gone.append(name)
    print('deleted workflow', name, '(backup in', backup + ')')

if gone:
    notes = call('GET', '/api/notifications?limit=500')
    for note in (notes.get('notifications') if isinstance(notes, dict) else notes) or []:
        about = (note.get('title', '') + ' ' + json.dumps(note.get('metadata') or {})).lower()
        if not note.get('read') and any(name.lower() in about for name in gone):
            call('POST', f"/api/console/notifications/{urllib.parse.quote(note['id'], safe='')}/read", {})
