# Editor Fixture Bundle

This directory contains deterministic, checked-in metadata fixtures for editor Phase 0. Generated media and copied metadata are written to the ignored `../output/` directory.

## Contents

- `project.json` describes a target editor project with screen, camera, separate audio, cursor, captions, a timeline gap, and a speed-adjusted clip.
- `project-cuts-locks.json` describes a project with explicit split cuts, a locked microphone track, and a locked zoom segment.
- `project-duplicate-ranges.json` describes a project where the same source range appears in two non-overlapping timeline clips to test source↔timeline mapping.
- `project-long.json` describes a five-minute project for timeline and playback performance checks.
- `project-no-cursor.json` describes an imported MP4 with unavailable cursor metadata.
- `project-overlays.json` describes the Phase 0 overlay engine fixture with annotations, titles, and a copied external SVG image on one overlay track.
- `external-logo.svg` is the deterministic, script-free external image referenced by `project-overlays.json`.
- `cursor-telemetry.json` contains source-relative cursor events, including left/right click samples and a non-16:9 source size.
- `captions.srt` contains deterministic caption timing for import and split/ripple tests.

## Generate Media

From the repository root:

```bash
bun run fixtures:generate
```

Use `bun run fixtures:generate -- --include-long` to also create the five-minute performance asset. Use `--force` to discard existing generated media and regenerate it.

The generator writes these editor assets to `tooling/fixtures/output/`:

- `1080p30_10s.mp4` - 16:9 screen source.
- `4_3_aspect_10s.mp4` - 4:3 screen source.
- `ultrawide_10s.mp4` - ultrawide screen source.
- `camera_10s.mp4` - secondary video source.
- `microphone_10s.wav` - microphone source.
- `system_audio_10s.wav` - system-audio source.
- `720p30_5m.mp4` - optional five-minute performance source, generated with `--include-long`.

The generator also copies the checked-in project, cursor, caption, and overlay metadata into the output directory so their relative asset paths resolve without remapping. Phase 1 will validate and migrate these target project shapes through the durable project contract.

Increment the generator's `FIXTURE_RECIPE_VERSION` whenever a media recipe, encoder setting, or expected media property changes so stale generated files are rebuilt.

## Fixture Invariants

- All media uses deterministic lavfi sources.
- The base `project.json` contains an intentional two-second timeline gap and a speed-adjusted clip.
- `project-cuts-locks.json` contains explicit cuts and locked tracks to test ripple/lock behavior.
- `project-duplicate-ranges.json` contains overlapping source ranges to test mapping ambiguity.
- Cursor coordinates are relative to the declared source dimensions.
- Captions have stable millisecond boundaries.
- `project-overlays.json` keeps annotation, title, and external-image clips on one overlay track.
- The external SVG fixture contains no scripts, event handlers, or external references.
- No fixture contains user media, secrets, or absolute machine paths.
