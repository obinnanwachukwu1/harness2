#!/bin/bash
set -euo pipefail

APP_DIR="${HARBOR_APP_DIR:-/app}"
cd "$APP_DIR"

node <<'EOF'
const fs = require('node:fs');
const path = 'app/page.tsx';
let source = fs.readFileSync(path, 'utf8');
source = source.replace(
  '<h1>To get started, edit the page.tsx file.</h1>',
  '<h1>Harbor smoke test</h1>'
);
source = source.replace(
  'Looking for a starting point or more instructions? Head over to{" "}',
  'Next app router smoke test. Looking for a starting point or more instructions? Head over to{" "}'
);
fs.writeFileSync(path, source);
EOF
