#!/usr/bin/env bash
# Test de charge basique: envoie un PDF proche de 1 Go, mesure la duree,
# et (si `cf` est disponible et loggue) releve la memoire de l'instance
# pendant le traitement pour verifier l'absence d'OOM/redemarrage CF.
#
# Usage: ./test/load-test-1gb.sh <fichier-1go.pdf> [nom-app-cf]

set -euo pipefail

PDF_PATH="${1:?Usage: load-test-1gb.sh <fichier.pdf> [nom-app-cf]}"
CF_APP="${2:-}"

echo "Fichier: $PDF_PATH ($(du -h "$PDF_PATH" | cut -f1))"

if [[ -n "$CF_APP" ]] && command -v cf >/dev/null 2>&1; then
  echo "Surveillance memoire de l'app CF '$CF_APP' pendant le traitement..."
  ( while true; do cf app "$CF_APP" | grep -E '^\s*#0' || true; sleep 5; done ) &
  MONITOR_PID=$!
  trap 'kill "$MONITOR_PID" 2>/dev/null || true' EXIT
fi

node "$(dirname "$0")/compress-and-report.js" "$PDF_PATH"
