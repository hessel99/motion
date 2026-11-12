#!/usr/bin/env bash
# runs REAL figma clipboard captures through our importer. the captures belong to
# github.com/darknoon/figma-format-parse (no license file), so they are downloaded on demand
# into a temp dir instead of being copied into this repo.
set -euo pipefail
DIR="${TMPDIR:-/tmp}/figma-format-parse"
[ -d "$DIR" ] || git clone -q --depth 1 https://github.com/darknoon/figma-format-parse.git "$DIR"
npx vite-node bench/figma-real.ts -- "$DIR/packages/fig-kiwi/data"
