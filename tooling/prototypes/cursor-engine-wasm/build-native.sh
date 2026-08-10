#!/usr/bin/env bash
set -euo pipefail

# Build the prototype for the native Windows target and run the parity smoke test.

cd "$(dirname "$0")"

cargo build --release
cargo run --bin parity_test
