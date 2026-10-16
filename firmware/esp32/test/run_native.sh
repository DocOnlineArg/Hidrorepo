#!/usr/bin/env bash
# Compila y ejecuta las pruebas nativas de la capa de seguridad del firmware.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/native/build"
mkdir -p "$OUT"
g++ -std=c++17 -Wall -Wextra -Werror -O1 \
  "$DIR/native/test_safety.cpp" "$DIR/../lib/hydro_safety/src/OutputSafety.cpp" \
  -o "$OUT/test_safety"
"$OUT/test_safety"
