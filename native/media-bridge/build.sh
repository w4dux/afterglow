#!/usr/bin/env bash
# Builds the media bridge and copies it to resources/bin.
#   build.sh            both targets the host can build (default)
#   build.sh windows    Windows x64 (mingw cross-compile) -> afterglow-media-bridge.exe
#   build.sh linux      Linux x64, static musl (runs on any glibc/musl distro) -> afterglow-media-bridge
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../resources/bin
want="${1:-all}"

build_windows() {
  cargo build --release --target x86_64-pc-windows-gnu
  cp target/x86_64-pc-windows-gnu/release/afterglow-media-bridge.exe ../../resources/bin/
  ls -la ../../resources/bin/afterglow-media-bridge.exe
}

build_linux() {
  rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true
  cargo build --release --target x86_64-unknown-linux-musl
  cp target/x86_64-unknown-linux-musl/release/afterglow-media-bridge ../../resources/bin/
  chmod +x ../../resources/bin/afterglow-media-bridge
  ls -la ../../resources/bin/afterglow-media-bridge
}

case "$want" in
  windows) build_windows ;;
  linux) build_linux ;;
  all)
    if command -v x86_64-w64-mingw32-gcc >/dev/null; then build_windows; else echo "skipping Windows build (no mingw)"; fi
    if [ "$(uname -s)" = "Linux" ]; then build_linux; else echo "skipping Linux build (not on Linux)"; fi
    ;;
  *) echo "usage: build.sh [windows|linux|all]" >&2; exit 2 ;;
esac
