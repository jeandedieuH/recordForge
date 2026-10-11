# Overlay font bundle licensing

## Phase 0 decision

The overlay engine uses the following four font files for preview/export parity:

| Family         | File                               | License                   | Role               |
| -------------- | ---------------------------------- | ------------------------- | ------------------ |
| Inter Variable | `Inter-VariableFont_slnt,wght.ttf` | SIL Open Font License 1.1 | Default sans       |
| Source Serif 4 | `SourceSerif4-Regular.ttf`         | SIL Open Font License 1.1 | Serif fallback     |
| JetBrains Mono | `JetBrainsMono-Regular.ttf`        | SIL Open Font License 1.1 | Monospace fallback |
| Outfit         | `Outfit-VariableFont_wght.ttf`     | SIL Open Font License 1.1 | Heading            |

The selected families are approved for application bundling under `OFL-1.1`. The
upstream copyright and license notices must remain with the corresponding font
files, and the exact upstream license text must be copied here when the binary
bundle is vendored.

Phase 0 freezes the file names, roles, and license policy only. The binary files
are added with the native resource packaging and text-shaping work in the later
export phase; this keeps the architecture fixture-only until the renderer owns
font loading.

## Derived static Inter instances

`inter-semibold.ttf`, `inter-bold.ttf`, and `inter-extrabold.ttf` are static
instances derived from the vendored `inter.ttf` (Inter Variable 4.001, axes
`opsz` 14–32 + `wght` 100–900) at `opsz=14` — the axis' default instance, which
matches both the variable font's default rendering and libass's default
instance resolution. libass cannot resolve named variable instances, so
caption burn-in ships these three static weights; nameID 1 is
`Inter SemiBold` / `Inter` (subfamily `Bold`) / `Inter ExtraBold`.

They remain under OFL-1.1 (license text in `inter-OFL.txt`; the font declares
no reserved font name). Generation commands (fonttools ≥ 4.40, run from this
directory — tooling is not vendored):

```bash
fonttools varLib.instancer inter.ttf wght=600 opsz=14 --update-name-table -o inter-semibold.ttf
fonttools varLib.instancer inter.ttf wght=700 opsz=14 --update-name-table -o inter-bold.ttf
fonttools varLib.instancer inter.ttf wght=800 opsz=14 --update-name-table -o inter-extrabold.ttf
```
