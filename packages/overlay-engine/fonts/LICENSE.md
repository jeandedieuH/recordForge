# Overlay font bundle licensing

## Phase 0 decision

The overlay engine uses the following four font files for preview/export parity:

| Family | File | License | Role |
| --- | --- | --- | --- |
| Inter Variable | `Inter-VariableFont_slnt,wght.ttf` | SIL Open Font License 1.1 | Default sans |
| Source Serif 4 | `SourceSerif4-Regular.ttf` | SIL Open Font License 1.1 | Serif fallback |
| JetBrains Mono | `JetBrainsMono-Regular.ttf` | SIL Open Font License 1.1 | Monospace fallback |
| Outfit | `Outfit-VariableFont_wght.ttf` | SIL Open Font License 1.1 | Heading |

The selected families are approved for application bundling under `OFL-1.1`. The
upstream copyright and license notices must remain with the corresponding font
files, and the exact upstream license text must be copied here when the binary
bundle is vendored.

Phase 0 freezes the file names, roles, and license policy only. The binary files
are added with the native resource packaging and text-shaping work in the later
export phase; this keeps the architecture fixture-only until the renderer owns
font loading.
