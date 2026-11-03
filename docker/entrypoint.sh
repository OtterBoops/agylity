#!/bin/sh
# Refresh the baked agy at boot; the installer has no version flag, so an image is only as
# current as its build date. Fail-soft: no network must not stop the container starting.
# AGY_UPDATE_ON_BOOT=background starts the app first and refreshes alongside; default blocks.
set -e

MODE="${AGY_UPDATE_ON_BOOT:-blocking}"

update_agy() {
  before=$(agy --version 2>/dev/null || echo unknown)
  if timeout 300 agy update >/tmp/agy-update.log 2>&1; then
    after=$(agy --version 2>/dev/null || echo unknown)
    if [ "$before" = "$after" ]; then
      echo "[entrypoint] agy ${after} (already current)"
    else
      echo "[entrypoint] agy updated ${before} -> ${after}"
    fi
  else
    echo "[entrypoint] agy update failed; continuing on ${before}"
    tail -5 /tmp/agy-update.log 2>/dev/null | sed 's/^/[entrypoint]   /' || true
  fi
}

if ! command -v agy >/dev/null 2>&1; then
  echo "[entrypoint] WARNING: agy not found on PATH; quota polling via CLI will fail"
elif [ "$MODE" = "background" ]; then
  echo "[entrypoint] agy $(agy --version 2>/dev/null || echo unknown); refreshing in background"
  update_agy &
else
  update_agy
fi

exec "$@"
