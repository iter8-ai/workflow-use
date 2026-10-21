#!/usr/bin/env bash
# See .no-mistakes.yaml for gate commands and validation instructions.
# Changed areas are compared with the merge base of HEAD and origin/main.
# test mirrors the CI "Recording" workflow's recording job for touched areas (Playwright browsers are never installed);
# lint mirrors the lint checks of the CI "Lint" and "Recording" workflows for touched areas.
# serve runs the recording service from this checkout on loopback with the installed Google Chrome
# (no Browserbase, no Playwright browser install) for the gate's live validation.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

base() {
  git merge-base HEAD origin/main 2>/dev/null || {
    echo "cannot determine branch baseline: origin/main merge-base is unavailable" >&2
    exit 2
  }
}

has() { grep -qx "$1" <<< "$areas"; }

main_checkout() {
  local common main
  common="$(git rev-parse --path-format=absolute --git-common-dir)"
  main="$(dirname "$common")"
  [ -d "$main/extension/node_modules" ] || main="$HOME/reiterate/workflow-use"
  printf '%s' "$main"
}

# A touched npm area without dependencies fails visibly instead of being skipped.
modules() {
  [ -e "$1/node_modules" ] && return 0
  echo "$1/node_modules is missing: run npm ci once in $(main_checkout)/$1 (prepare links it from there)" >&2
  return 1
}

case "${1:-}" in
  test|lint)
    baseline="$(base)"
    areas="$(git diff --name-only "$baseline" HEAD | awk -F/ '{print $1}' | sort -u)"
    ;;
esac

case "${1:-}" in
  prepare)
    main="$(main_checkout)"
    for dir in extension; do
      [ -e "$dir/node_modules" ] && continue
      [ -d "$main/$dir/node_modules" ] || continue
      ln -s "$main/$dir/node_modules" "$dir/node_modules"
      echo "linked $dir/node_modules -> $main/$dir/node_modules"
    done
    ;;
  test)
    "$0" prepare
    status=0
    if has recording; then
      (cd recording && uv sync -q --frozen --group dev && uv run --no-sync pytest -q) || status=1
    fi
    # workflows/ has no CI test job; its lint runs in the lint step.
    has recording || echo "no recording changes"
    exit $status
    ;;
  serve)
    # Foreground. Service key "gate" is for this disposable local run only; recordings live in process memory.
    port="${WORKFLOW_USE_PORT:-8090}"
    channel="${WORKFLOW_USE_BROWSER_CHANNEL:-chrome}"
    echo "WORKFLOW_USE_BASE_URL=http://127.0.0.1:$port"
    echo "WORKFLOW_USE_SERVICE_KEY=gate"
    cd recording && uv sync -q --frozen --group dev && WORKFLOW_USE_SERVICE_KEY=gate exec uv run --no-sync python - "$port" "$channel" <<'PY'
import sys

import uvicorn

from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.provider import LocalPlaywrightProvider

port, channel = int(sys.argv[1]), sys.argv[2]
provider = LocalPlaywrightProvider(channel=channel or None, headless=False)
uvicorn.run(create_app(provider, RecordingConfig(service_key="gate")), host="127.0.0.1", port=port)
PY
    ;;
  lint)
    "$0" prepare
    status=0
    if has recording; then
      # The Recording workflow runs this Ruff check.
      (cd recording && uv sync -q --frozen --group dev && uv run --no-sync ruff check .) || status=1
    fi
    if has workflows; then
      (cd workflows && uv run ruff check && uv run ruff format --check) || status=1
    fi
    if has extension; then
      if modules extension; then
        (cd extension && npm run -s lint && npm run -s compile) || status=1
      else
        status=1
      fi
    fi
    exit $status
    ;;
  *)
    echo "usage: scripts/gate-test.sh prepare|test|lint|serve" >&2
    exit 2
    ;;
esac
