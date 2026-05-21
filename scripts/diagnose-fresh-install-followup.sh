#!/usr/bin/env bash
# Run this on the fresh-install machine where you saw the three symptoms:
#
#   1. Wizard popped up AFTER you got into the app
#   2. Command Line Tools installer popup AFTER you got in
#   3. Keychain password prompt
#
# Captures the desktop supervisor log + the daemon's CLI scan state +
# Keychain entries under the Clementine service. Prints them so you can
# paste back, or saves them to ~/Desktop/clementine-diagnose.txt.
#
# Read-only — does not change anything on the machine.

set -u
OUT="${HOME}/Desktop/clementine-diagnose.txt"
LOG="${HOME}/.clementine-next/logs/desktop/supervisor.log"
STATE="${HOME}/.clementine-next/state"

{
  echo "═════════════════════════════════════════════════════════════"
  echo "  Clementine fresh-install diagnostic"
  echo "═════════════════════════════════════════════════════════════"
  echo "  date:   $(date)"
  echo "  uname:  $(uname -srm)"
  echo "  user:   $(whoami)"
  echo "  HOME:   $HOME"

  echo
  echo "── Installed app version ────────────────────────────────────"
  if [[ -d /Applications/Clementine.app ]]; then
    defaults read /Applications/Clementine.app/Contents/Info.plist CFBundleShortVersionString 2>&1
  else
    echo "  /Applications/Clementine.app NOT FOUND"
  fi

  echo
  echo "── Command Line Tools status ────────────────────────────────"
  echo "  xcode-select -p: $(xcode-select -p 2>&1)"
  for d in /Library/Developer/CommandLineTools /Applications/Xcode.app; do
    echo -n "  $d: "
    [[ -d "$d" ]] && echo "EXISTS" || echo "missing"
  done
  echo "  CLT package receipt:"
  pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>&1 | sed 's/^/    /'

  echo
  echo "── ~/.clementine-next/state contents ────────────────────────"
  if [[ -d "$STATE" ]]; then
    ls -la "$STATE" 2>&1
    echo
    for f in setup-complete.json keychain-migrated.json secrets-vault.json secrets-meta.json; do
      if [[ -f "$STATE/$f" ]]; then
        echo "  --- $f ---"
        # Truncate large files; mask credential values.
        if [[ "$f" == "secrets-vault.json" ]]; then
          python3 -c "import json,sys; d=json.load(open('$STATE/$f')); print('  vault entry keys:', list(d.get('entries',{}).keys()))" 2>&1 || echo "  (parse failed)"
        else
          head -c 1000 "$STATE/$f" | sed 's/^/    /'
        fi
        echo
      fi
    done
  else
    echo "  STATE DIR NOT FOUND ($STATE)"
  fi

  echo
  echo "── CLI scan cache (~/.clementine-next/state/cli-scan.json) ──"
  if [[ -f "$STATE/cli-scan.json" ]]; then
    python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.clementine-next/state/cli-scan.json')
try:
    d = json.load(open(p))
    entries = d.get('entries') or d.get('cliScan') or {}
    if isinstance(entries, list):
        entries = {e.get('command', 'unknown'): e for e in entries}
    skipped, allowed = [], []
    for k, v in entries.items():
        if isinstance(v, dict) and v.get('skipped'):
            skipped.append((k, v.get('reason', '')[:80]))
        else:
            allowed.append(k)
    print(f"  entries: {len(entries)}  skipped: {len(skipped)}  allowed: {len(allowed)}")
    print("  skipped/usr/bin-like:")
    for k, r in skipped[:20]:
        print(f"    {k}: {r}")
    print("  allowed:")
    for k in sorted(allowed)[:30]:
        print(f"    {k}")
except Exception as e:
    print(f"  (parse failed: {e})")
PY
  else
    echo "  cli-scan.json NOT PRESENT"
  fi

  echo
  echo "── Boot / wizard / migration log lines ──────────────────────"
  if [[ -f "$LOG" ]]; then
    echo "  log size: $(wc -l < "$LOG") lines"
    echo
    echo "  Recent boot/migration markers (last 200 relevant lines):"
    grep -E "Boot failure|Keychain migration|setup-complete|needsSetup|Daemon started|capability|stub|/usr/bin|CommandLineTools|xcode-select|toolchain" "$LOG" 2>/dev/null | tail -50 | sed 's/^/    /'
    echo
    echo "  Last 30 lines of supervisor.log (anything interesting near the popups):"
    tail -30 "$LOG" 2>/dev/null | sed 's/^/    /'
  else
    echo "  $LOG NOT PRESENT — has the desktop app launched on this account?"
  fi

  echo
  echo "── Keychain entries under com.clemmy.desktop.v1 ─────────────"
  # security find-generic-password with -g would prompt; use dump-keychain
  # filter (read-only metadata, no auth prompt) to enumerate.
  if command -v security >/dev/null 2>&1; then
    DUMP=$(security dump-keychain 2>/dev/null)
    echo "$DUMP" | python3 -c '
import sys, re
text = sys.stdin.read()
blocks = re.split(r"\nattributes:\n", text)
new_svc, old_svc = [], []
for b in blocks:
    m = re.search(r"\"acct\"<blob>=\"([^\"]+)\"", b)
    if not m: continue
    acct = m.group(1)
    if "\"svce\"<blob>=\"com.clemmy.desktop.v1\"" in b: new_svc.append(acct)
    elif "\"svce\"<blob>=\"clementine\"" in b: old_svc.append(acct)
print(f"  com.clemmy.desktop.v1 entries ({len(new_svc)}):")
for a in sorted(set(new_svc)): print(f"    {a}")
print(f"  legacy \"clementine\" entries ({len(old_svc)}) — should be 0 after the cleanup we shipped:")
for a in sorted(set(old_svc)): print(f"    {a}")
'
  fi

  echo
  echo "── Process count ────────────────────────────────────────────"
  pgrep -fl "Clementine.app/Contents/MacOS/Clementine" 2>/dev/null | sed 's/^/    /'
  electrons=$(pgrep -fl "Clementine.app" 2>/dev/null | wc -l | tr -d ' ')
  echo "  Clementine-related processes running: $electrons (expected: ~10-15 for a single instance)"

  echo
  echo "═════════════════════════════════════════════════════════════"
  echo "  Done. Full output saved to: $OUT"
  echo "═════════════════════════════════════════════════════════════"
} 2>&1 | tee "$OUT"
