#!/bin/bash
set -euo pipefail

cd /app

stdout_path=/logs/verifier/test-stdout.txt
stderr_path=/logs/verifier/test-stderr.txt

if ! grep -q 'Harbor smoke test' app/page.tsx; then
  echo "Missing heading text in app/page.tsx" | tee "$stderr_path"
  echo 0 > /logs/verifier/reward.txt
  exit 1
fi

if ! grep -q 'Next app router smoke test' app/page.tsx; then
  echo "Missing body text in app/page.tsx" | tee "$stderr_path"
  echo 0 > /logs/verifier/reward.txt
  exit 1
fi

if npm run build >"$stdout_path" 2>"$stderr_path"; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
  exit 1
fi
