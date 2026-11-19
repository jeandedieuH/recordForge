# ADR 020: GPU-First Export Effects and Downgrade Reporting

## Status

Accepted — 2026-11-15. Amends ADR 018 ("the FFmpeg graph stays authoritative:
it renders every feature").

## Context

The creator-feature program (motion blur, Glass Loupe zoom, source-resolution
zoom detail with sharpening, camera cutout silhouettes, animated camera
layouts, video b-roll layers) adds per-pixel effects that map naturally onto
the wgpu compositor (ADR 018) but are either very expensive or not expressible
in an FFmpeg `filter_complex` graph:

- Motion blur needs N sub-frame samples of the zoom crop per moving frame.
  The graph equivalent (supersample + `tmix`) multiplies the whole pipeline
  cost, even for frames that do not move.
- The loupe's glass rim (refraction offset along the SDF normal, inner
  highlight, soft SDF shadow) has no filter equivalent.
- Silhouette shadows of a cut-out camera need a blurred, offset copy of the
  matte composited under the person; feasible in a graph but costly per frame.

Holding every new effect to "compat renders it identically" would either block
these features or make the compatibility renderer — the fallback for machines
without a qualifying adapter — markedly slower. The product decision is that
full quality lives on the GPU path, while the compatibility path stays fast and
renders an honest, documented approximation.

## Decision

1. **GPU-first effects.** New pixel effects are specified against the wgpu
   compositor. Each effect also has a compatibility-renderer behaviour,
   chosen per effect and documented below: an exact implementation where it is
   cheap, otherwise a named approximation or omission.
2. **No silent differences.** Whenever an export renders an effect at less
   than full quality, the render returns an `EffectDowngrade { effect, reason }`
   entry. Downgrades are persisted on the export job
   (`MediaJobOutputs.renderNotes`) and shown in the export UI as a
   non-blocking notice. They are logged with the effect id only (no paths, no
   media content).
3. **Single source of truth.** `gpu::effect_support(plan, settings)` lives next
   to `gpu::plan_limitations` and decides, per effect present in a plan, whether
   it renders at full quality on the renderer that will actually run. The same
   function produces the downgrade list for compatibility renders, GPU-gated
   fallbacks (`plan_limitations` non-empty) and runtime GPU failures that fall
   back to FFmpeg.
4. **Zero cost when unused.** An effect absent from the plan must not add a
   decode sidecar, render pass, plate, shader tap or filter. Identity and
   plate-free plans must stay bit-identical against the compatibility renderer
   (ADR 018 parity rule unchanged for existing features).
5. **Existing features are unchanged.** Everything ADR 018 shipped keeps the
   parity profile (mean ≥ 40 dB, min ≥ 28 dB at equal encode segmentation).
   Only new effects may use the approximation path.

### Effect table

| Effect | GPU compositor | Compatibility renderer | Downgrade reported |
| --- | --- | --- | --- |
| Zoom detail plane (source-resolution crop) | Exact: the screen chain decodes at the plan's detail resolution (`D = content × min(m, r)`, never above the source) and the composite pass samples the real source pixels | Holds exact; animated transitions sample the post-scale stream | `zoom-detail` when a transition is post-scale |
| Zoom sharpening (RCAS-style) | Exact | Mild luma `unsharp` | `zoom-sharpening` |
| Motion blur — cursor | Exact (shared Rust rasterizer, up to 24 linearly accumulated shutter poses) | Exact (same rasterizer) | never |
| Motion blur — zoom/pan | Exact (up to 24 tapered bilinear shader taps along continuous shutter strip) | Tapered `zoompan`+`mix` taps with independent zoom/pan shutter timing, capped at 7 | `motion-blur` only when the output-screen sweep exceeds the tap cap |
| Glass Loupe | Exact (analytic SDF lens, glass rim, SDF shadow) | Lens rebuilt from `crop`/`geq`/`sendcmd`/`overlay`; the glass rim is approximated | `loupe-glass` only when the glass rim is on |
| Camera colour / LUT | Exact (camera decode chain) | Exact (same FFmpeg chain) | never |
| Camera cutout matte + background modes | Exact (camera decode chain) | Exact (same FFmpeg chain) | never |
| Camera cutout silhouette shadow | Exact | Omitted | `cutout-shadow` |
| Face-tracking crop | Exact (camera decode chain) | Exact | never |
| Animated camera layouts | Exact | Exact (`eval=frame` expressions) | never |
| Border styles (screen/camera) | Canvas SDF ring; camera plate | Static plates | `canvas-border` when a moving side-by-side layout outgrows the static plate |

The table is updated whenever an effect is added; an effect without a row may
not ship.

### M2 implementation notes (2026-11-15)

- **Detail plane shape.** The screen chain decodes at the detail resolution
  instead of adding a second sidecar: `plane = canvas × min(m_max, r)`, the
  content rect scales with it, and the composite pass reads `plane_size` for its
  uv mapping. Consequence: while a detail plane is active, the per-frame
  identity bypass is off (every frame is composed, which is what keeps
  identity → encoder passthrough valid) and the raw NV12 pipe grows by up to
  `(D / content)²`. The plan analysis (`.exports/zoom_detail.rs`) reports which
  frame ranges need it and the RCAS strength; a plan without zoom keeps today's
  plane size and bypass.
- **Motion blur cost.** Cursor blur integrates up to 24 tapered shutter poses
  linearly in premultiplied RGBA inside the shared rasterizer (preserving 100%
  core opacity with zero Porter-Duff wash-out), synchronized with sub-frame zoom
  transforms when zoom/pan blur is also active; sub-pixel movement falls back to
  one pose. Zoom/pan blur uses independent symmetric half-windows (`0.5` = 180°
  cinema shutter, `1.0` = 360° full-frame shutter) and integrates up to 24
  tapered hardware bilinear taps along a continuous normalized crop strip in
  `composite.wgsl` (skipping RCAS sharpening on blurred frames); the
  compatibility graph rebuilds the same sweep as shifted `zoompan` branches
  blended by tapered `mix` weights, capped at 7 and keeping blurred ramp frames
  out of `Hold` pieces. A plan with blur off takes the existing single-sample
  path on both renderers, so the cost is zero.
- **Glass Loupe compat.** The compatibility graph has no cheap "magnify a region
  inside a masked lens" equivalent that also follows the cursor, so it
  synthesizes the lens from filters: `crop@loupe` samples the fitted screen
  plate, a `geq` disc masks it, a `geq` plate draws ring/shadow/glass
  approximation, and `sendcmd` positions both overlays per frame — the same
  mechanism the cursor tile uses. The GPU path draws the lens analytically in
  the composite pass between the screen and the cursor.

## Consequences

- Machines without a qualifying GPU still export quickly, with an explicit
  notice listing what was simplified.
- The compatibility renderer remains the parity reference for every feature
  that existed before this ADR and for every "exact" row above.
- Parity tooling must exclude approximated effects: specs for those effects
  compare GPU output against a GPU golden reference (golden-frame suite)
  rather than against the compatibility render.
- Support can reproduce a user's output by checking `renderNotes` on the job.

## Alternatives Considered

- **Full parity in both renderers.** Rejected: slows the fallback path and
  multiplies implementation cost for effects most users will see on the GPU.
- **Fail exports that use GPU-only effects without a GPU.** Rejected: failing
  an export over a visual flourish is worse than rendering it simplified.
