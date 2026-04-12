#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT_PATH="${1:-$ROOT_DIR/.artifacts/h2-harbor-runtime.tar.gz}"
TMP_DIR="$(mktemp -d)"
RUNTIME_DIR="$TMP_DIR/h2-harbor-runtime"
DEFAULT_INCLUDE_NODE_BINARY=0
case "$(uname -s)" in
  Linux)
    DEFAULT_INCLUDE_NODE_BINARY=1
    ;;
esac
INCLUDE_NODE_BINARY="${H2_INCLUDE_NODE_BINARY:-$DEFAULT_INCLUDE_NODE_BINARY}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$RUNTIME_DIR/bin"

cd "$ROOT_DIR"
npm run build

cp package.json "$RUNTIME_DIR/package.json"
rsync -a dist/ "$RUNTIME_DIR/dist/"
rsync -a node_modules/ "$RUNTIME_DIR/node_modules/"

if [ "$INCLUDE_NODE_BINARY" = "1" ] && command -v node >/dev/null 2>&1; then
  mkdir -p "$RUNTIME_DIR/node/bin"
  cp "$(command -v node)" "$RUNTIME_DIR/node/bin/node"
  chmod +x "$RUNTIME_DIR/node/bin/node"
fi

cat >"$RUNTIME_DIR/bin/h2" <<'EOF'
#!/usr/bin/env sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -x "$DIR/node/bin/node" ]; then
  exec "$DIR/node/bin/node" "$DIR/dist/cli.js" "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$DIR/dist/cli.js" "$@"
fi

echo "No Node runtime found for h2 Harbor bundle." >&2
exit 1
EOF
chmod +x "$RUNTIME_DIR/bin/h2"

mkdir -p "$(dirname "$OUT_PATH")"
tar -czf "$OUT_PATH" -C "$TMP_DIR" h2-harbor-runtime
echo "$OUT_PATH"
