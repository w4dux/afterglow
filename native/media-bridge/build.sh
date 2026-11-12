#!/usr/bin/env bash
# Cross-compiles the bridge for Windows x64 (mingw) and copies it to resources/bin.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target x86_64-pc-windows-gnu
mkdir -p ../../resources/bin
cp target/x86_64-pc-windows-gnu/release/afterglow-media-bridge.exe ../../resources/bin/
ls -la ../../resources/bin/afterglow-media-bridge.exe
