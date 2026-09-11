#!/usr/bin/env bash
# Cursor ships a rust-analyzer that only talks to rustc 1.94+.
# This repo pins 1.84.1 (LayerZero / Anchor 0.31.1). Use that toolchain's
# rust-analyzer so the editor matches what we compile with.
set -euo pipefail
exec "$(rustup which rust-analyzer --toolchain 1.84.1)" "$@"
