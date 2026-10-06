#!/usr/bin/env bash
# See .no-mistakes.yaml for gate commands and validation instructions.
# Changed areas are compared with the merge base of HEAD and origin/main.
# test mirrors the CI "Agent setup" jobs for touched areas (Playwright browsers are never installed);
# lint mirrors the lint checks of the CI "Lint" and "Agent setup" workflows for touched areas.
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
  [ -d "$main/ui/node_modules" ] || main="$HOME/reiterate/workflow-use"
  printf '%s' "$main"
}

# A touched npm area without dependencies fails visibly instead of being skipped.
modules() {
  [ -e "$1/node_modules" ] && return 0
  echo "$1/node_modules is missing: run npm ci once in $(main_checkout)/$1 (prepare links it from there)" >&2
  return 1
}

ui_ready() {
  modules ui && npm --prefix ui run -s type-gen >/dev/null
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
    for dir in ui extension; do
      [ -e "$dir/node_modules" ] && continue
      [ -d "$main/$dir/node_modules" ] || continue
      ln -s "$main/$dir/node_modules" "$dir/node_modules"
      echo "linked $dir/node_modules -> $main/$dir/node_modules"
    done
    ;;
  test)
    "$0" prepare
    status=0
    if has ui; then
      if ui_ready; then
        (cd ui && npm test) || status=1
        (cd ui && npx tsc --noEmit -p .) || status=1
        # Fixture-driven setup flows (e2e/agent-setup.spec.ts) on a private port; CI=1 stops
        # Playwright from reusing another run's dev server.
        port=$((41000 + RANDOM % 900))
        (cd ui && CI=1 PLAYWRIGHT_BASE_URL="http://127.0.0.1:$port" npx playwright test) || status=1
      else
        status=1
      fi
    fi
    if has recording; then
      (cd recording && uv sync -q --frozen --group dev && uv run --no-sync pytest -q) || status=1
    fi
    # workflows/ has no CI test job; its lint runs in the lint step.
    has ui || has recording || echo "no ui or recording changes"
    exit $status
    ;;
  lint)
    "$0" prepare
    status=0
    if has ui; then
      if ui_ready; then
        npm --prefix ui run -s lint || status=1
        (cd ui && npx tsc --noEmit -p .) || status=1
      else
        status=1
      fi
    fi
    if has recording; then
      # The Agent setup workflow's recording job runs this ruff check.
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
    echo "usage: scripts/gate-test.sh prepare|test|lint" >&2
    exit 2
    ;;
esac
