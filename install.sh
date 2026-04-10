#!/usr/bin/env bash
set -euo pipefail

echo "Installing Clementine Next..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required. Current: $(node --version)"
  exit 1
fi

npm install
npm run init-home
npm run doctor
npm run typecheck

echo
echo "Install complete."
echo "Next:"
echo "  1. Run: npm run setup"
echo "  2. Then run: npm run service"
echo "  3. Optional global dev link: npm link"
