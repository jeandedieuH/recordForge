#!/usr/bin/env bash
set -euo pipefail

# Build the prototype for wasm32 and package it with wasm-pack.
# wasm-pack must be installed: cargo install wasm-pack
# The wasm32-unknown-unknown target must also be installed:
#   rustup target add wasm32-unknown-unknown

cd "$(dirname "$0")"

rustup target add wasm32-unknown-unknown || true
wasm-pack build --target web --out-dir pkg
