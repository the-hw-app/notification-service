#!/usr/bin/env bash
# Copy the QuickJS asyncify WASM into src/ so wrangler bundles it.
#
# Cloudflare's build only resolves `import wasm from "./x.wasm"` when the path
# is relative to your own source tree — a `.wasm` inside node_modules is not
# bundled (workers-sdk#1672). So we vendor a copy at build time rather than
# committing a 1MB binary. src/quickjs.wasm is gitignored.
set -euo pipefail

cd "$(dirname "$0")/.."

WASM_PATH="$(node -p 'require.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm")')"
cp -f "$WASM_PATH" src/quickjs.wasm
echo "copied $(basename "$WASM_PATH") -> src/quickjs.wasm ($(wc -c < src/quickjs.wasm) bytes)"
