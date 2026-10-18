# Vendored `libspa` (fork of upstream `libspa` 0.10.1)

Patched into `apps/desktop/src-tauri` via `[patch.crates-io]` in
`apps/desktop/src-tauri/Cargo.toml`. `libspa-sys` and `pipewire` stay stock
from crates.io.

## Why

Upstream `libspa` 0.10.x (and 0.8/0.9) cannot compile against PipeWire
development headers older than ~1.0:

- `spa_meta_first` and `spa_meta_region_is_valid` are plain `#define` macros on
  old headers (e.g. `libpipewire-0.3-dev` 0.3.48 on Ubuntu 22.04 LTS), so
  bindgen emits no symbols for them — upstream calls them unconditionally in
  `src/buffer/meta.rs`.
- `spa_video_info_raw.flags` does not exist (it was added mid-struct in 1.0)
  and `modifier` is `int64_t` where upstream expects `uint64_t` — both used
  unconditionally in `src/param/video/raw.rs`.

Result without this patch: `cargo check`/`test`/`build` fail inside `libspa`
before any app code compiles on Ubuntu 22.04 and other older-PipeWire distros.
CI uses `ubuntu-latest` (PipeWire 1.x) so it never caught this.

## How the patch works

`build.rs` probes the headers found by `system-deps`/`pkg-config` with two
`-fsyntax-only` compiles and emits cfgs:

- `spa_raw_no_flags` — set when `spa_video_info_raw` has no `flags` field.
  `VideoInfoRaw::new()` builds field-by-field, `set_flags()` becomes a no-op,
  `flags()` returns `VideoFlags::empty()`, and `modifier` uses `as _` casts
  (bit-exact across `i64`/`u64`).
- `spa_meta_macros` — set when the meta helpers are macros, not functions.
  `compat.c` is then compiled, exporting `pwrs_spa_meta_first` /
  `pwrs_spa_meta_region_is_valid` which call the macros; `src/compat.rs`
  routes `meta.rs` call sites there. On modern headers nothing changes.

The compat path preserves runtime semantics: the helpers are SPA header-level
functions whose POD wire format is stable across PipeWire versions.

## Maintenance

- The patch only applies while Cargo resolves `libspa` to 0.10.1 — a
  `cargo update` bumping `libspa`/`pipewire` past it makes this `[patch]`
  entry unused (Cargo warns). To re-vendor, copy the new registry sources
  over this directory and re-apply: `build.rs` probes + `compat.c`,
  `src/compat.rs` + `mod compat` in `src/lib.rs`, the two call-site changes
  in `src/buffer/meta.rs`, and the `new()`/`flags`/`modifier` changes in
  `src/param/video/raw.rs`. Diffing `src/` against the fresh registry copy
  shows exactly these.
- Remove the patch once upstream `libspa` compiles on PipeWire < 1.0 headers,
  or once the minimum supported distro ships PipeWire ≥ 1.0 headers.
