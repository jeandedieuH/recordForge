//! wgpu side of the native export compositor.
//!
//! The compositor owns one GPU device and the fixed set of resources a
//! composition pass needs: an NV12 screen plane pair, two RGBA stage targets
//! (ping-ponged by privacy-mask passes), generated overlay/camera layer
//! textures, and NV12 output buffers that are read back on the CPU and handed
//! straight to the encode sidecar's stdin.
//!
//! The device, adapter and pipelines are **process-wide**: creating them costs
//! ~2–3 s (adapter probe, DX12 device, naga/FXC shader compile), which is a
//! large share of a short export. Only size-dependent resources (planes, render
//! targets, layer textures, readback ring) are per export.
//!
//! Readback is pipelined through a ring of host-visible buffers: submitting a
//! frame hands back the frame that has been on the GPU longest, so the GPU
//! keeps working while the CPU copies and writes the previous one.
//!
//! Layers are composited in the same order as the compatibility graph: canvas
//! and screen, cursor, camera shadow/bubble/border, privacy masks, overlay
//! items, then keystroke badges. Burned-in captions stay in the encode sidecar
//! (libass parity), so they are not drawn here.
//!
//! The screen plane is always decoded into the full content rect; `dest_rect`
//! is the rect the current frame draws it at, which is the side-by-side slot
//! inside layout windows. Masks ping-pong between two stage targets.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::errors::Result;
use tracing::{info, warn};

use super::gpu_error;

const COMPOSITE_WGSL: &str = include_str!("shaders/composite.wgsl");
const LAYER_WGSL: &str = include_str!("shaders/layer.wgsl");
const MASK_WGSL: &str = include_str!("shaders/mask.wgsl");
const NV12_WGSL: &str = include_str!("shaders/nv12_encode.wgsl");

/// Readback buffers kept in flight. Three is enough to cover the copy-out while
/// the GPU still runs a frame or two ahead without inflating the latency of a
/// cancel.
const READBACK_RING: usize = 3;

/// Zoom crop in source pixels, already snapped by
/// `camera::zoompan_integer_crop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// One decoded NV12 screen frame: `width * height * 3 / 2` bytes, Y plane then
/// interleaved UV — exactly FFmpeg's `rawvideo`/`nv12` layout.
pub(super) struct Nv12Frame {
    pub data: Vec<u8>,
}

/// What to do with one timeline frame.
pub(super) enum Frame {
    /// Composite it through the GPU (zoom, canvas framing, layers).
    Compose(Nv12Frame),
    /// Forward the decoder's bytes untouched (identity zoom, no layers).
    Pass(Vec<u8>),
}

/// A generated overlay plane shipped for one frame: packed YUVA420p at the
/// plane rect's size, plus the canvas origin it draws at.
pub(super) struct PlaneFrame {
    pub data: std::sync::Arc<Vec<u8>>,
    pub dest: (u32, u32),
}

/// One active camera overlay's decoded NV12 frame for this output frame.
pub(super) struct CameraFrame {
    pub index: usize,
    pub data: Vec<u8>,
}

/// Mask shape for a generated overlay/camera quad.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Shape {
    Rect,
    /// Ellipse inscribed in the layer rect (camera "circle" shape).
    Circle,
    /// Rounded rectangle with this corner radius.
    Rounded(f32),
}

/// Privacy-mask treatment for one rect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum MaskMode {
    Redact([f32; 3]),
    /// Blur sampling factor (`factor` px between taps).
    Blur(f32),
    /// Pixel block size in px.
    Pixelate(f32),
}

/// One privacy mask's canvas rect and mode.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MaskConfig {
    pub rect: (u32, u32, u32, u32),
    pub mode: MaskMode,
}

/// Canvas rect a generated plate occupies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PlaneInfo {
    pub rect: (u32, u32, u32, u32),
}

/// One camera overlay's fixed composition geometry and optional generated
/// border/shadow plates.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct CameraConfig {
    /// Camera NV12 frame size.
    pub size: (u32, u32),
    /// Canvas origin.
    pub dest: (u32, u32),
    pub shape: Shape,
    pub opacity: f32,
    /// Generated border PNG bytes (device-ready).
    pub border: Option<Vec<u8>>,
    /// Generated shadow PNG bytes plus its canvas origin.
    pub shadow: Option<(Vec<u8>, u32, u32)>,
}

/// Per-export layer inventory. Everything is created once; only pixel data and
/// the cursor origin change per frame.
#[derive(Default)]
pub(super) struct CompositorSpec {
    pub cursor: Option<PlaneInfo>,
    pub items: Option<PlaneInfo>,
    pub keys: Option<PlaneInfo>,
    pub cameras: Vec<CameraConfig>,
    pub masks: Vec<MaskConfig>,
}

/// Canvas framing for one export: the full content rect, the optional
/// side-by-side slot and its active windows, corner rounding and background.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct CanvasFrame {
    /// Full content rect on the canvas, in canvas pixels: `(x, y, w, h)`. The
    /// decode sidecar always fits the screen into this rect.
    pub rect: (f64, f64, f64, f64),
    /// Smaller screen slot used inside side-by-side layout windows.
    pub sbs_rect: Option<(f64, f64, f64, f64)>,
    /// Absolute `[start_ms, end_ms)` windows where `sbs_rect` applies.
    pub sbs_windows: Vec<(u64, u64)>,
    /// Rounded corner radius in canvas pixels (0 = square).
    pub radius: u32,
    /// Solid background colour as sRGB floats, used when `plate` is `None`.
    pub background: [f32; 3],
    /// Canvas-size RGBA background plate (colour, gradient, image, blur, dim
    /// and the canvas shadow are all baked in by `prepare_canvas_background_plate`).
    pub plate: Option<PathBuf>,
    /// Second background plate with the shadow painted around `sbs_rect`; only
    /// present when the layout varies and the canvas has a shadow.
    pub sbs_plate: Option<PathBuf>,
}

impl CanvasFrame {
    /// True when the screen covers the whole canvas with square corners and no
    /// background is visible, so an identity-zoom frame needs no compositing.
    pub(super) fn is_plain(&self, width: u32, height: u32) -> bool {
        self.plate.is_none()
            && self.sbs_rect.is_none()
            && self.radius == 0
            && self.rect.0.abs() < 0.5
            && self.rect.1.abs() < 0.5
            && self.rect.2 >= width as f64 - 0.5
            && self.rect.3 >= height as f64 - 0.5
    }

    /// True while the side-by-side slot is active at `output_ms`.
    pub(super) fn side_by_side_at(&self, output_ms: f64) -> bool {
        self.sbs_rect.is_some()
            && self
                .sbs_windows
                .iter()
                .any(|(start, end)| output_ms >= *start as f64 && output_ms < *end as f64)
    }

    /// Screen rect to draw at `output_ms`.
    pub(super) fn dest_rect(&self, output_ms: f64) -> (f64, f64, f64, f64) {
        match self.sbs_rect {
            Some(sbs) if self.side_by_side_at(output_ms) => sbs,
            _ => self.rect,
        }
    }
}

/// Everything one output frame needs, excluding the decoded screen frame.
pub(super) struct FrameRequest {
    pub crop: Crop,
    /// Screen rect on the canvas for this frame (the full content rect, or the
    /// smaller side-by-side slot).
    pub dest: (f64, f64, f64, f64),
    /// Canvas corner radius (unscaled; the compositor scales it to `dest`).
    pub radius: u32,
    /// True when `dest` is the side-by-side slot, so the side-by-side
    /// background plate is sampled.
    pub side_by_side: bool,
    pub cursor: Option<PlaneFrame>,
    pub items: Option<PlaneFrame>,
    pub keys: Option<PlaneFrame>,
    pub cameras: Vec<CameraFrame>,
    /// Indices into [`CompositorSpec::masks`] active this frame, in plan order.
    pub masks: Vec<usize>,
}

fn nv12_len(width: u32, height: u32) -> usize {
    let luma = width as usize * height as usize;
    luma + luma / 2
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FrameParams {
    canvas_size: [f32; 4],
    dest_rect: [f32; 4],
    crop: [f32; 4],
    background: [f32; 4],
    corner: [f32; 4],
    source_rect: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Nv12Params {
    width: u32,
    height: u32,
    y_words_per_row: u32,
    uv_word_offset: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LayerParams {
    canvas_size: [f32; 4],
    dest_rect: [f32; 4],
    shape: [f32; 4],
    opacity: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MaskParams {
    rect: [f32; 4],
    color: [f32; 4],
    params: [f32; 4],
}

/// Minimal `Pod` substitute so the crate does not take a `bytemuck` dependency
/// for its uniform structs. Safety: all types are `#[repr(C)]`, made entirely
/// of `u32`/`f32`, and contain no padding.
mod bytemuck_free {
    /// # Safety
    /// Implementors must be plain-old-data: `#[repr(C)]`, no padding, no
    /// pointers, and valid for any bit pattern.
    pub unsafe trait Pod: Copy {}
    unsafe impl Pod for super::FrameParams {}
    unsafe impl Pod for super::Nv12Params {}
    unsafe impl Pod for super::LayerParams {}
    unsafe impl Pod for super::MaskParams {}
    unsafe impl Pod for [f32; 4] {}
}

/// Device + pipelines shared by every export in the process.
struct SharedGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_label: String,
    /// Set when the driver reports the device as lost. The cache drops the
    /// device and the next export builds a fresh one.
    lost: Arc<AtomicBool>,
    render_layout: wgpu::BindGroupLayout,
    compute_layout: wgpu::BindGroupLayout,
    layer_layout: wgpu::BindGroupLayout,
    mask_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
    compute_pipeline: wgpu::ComputePipeline,
    layer_pipeline: wgpu::RenderPipeline,
    mask_pipeline: wgpu::RenderPipeline,
}

static SHARED_GPU: OnceLock<Mutex<Option<Arc<SharedGpu>>>> = OnceLock::new();

/// One in-flight readback. Bypassed (identity) frames travel through the same
/// queue, already carrying their payload, so output order always matches
/// submission order.
enum Inflight {
    Gpu { slot: usize },
    Ready(Vec<u8>),
}

struct RingSlot {
    buffer: wgpu::Buffer,
    mapped: Option<std::sync::mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>>,
}

/// One composited layer's textures, uniform and bind group.
struct Quad {
    y: wgpu::Texture,
    uv: wgpu::Texture,
    a: wgpu::Texture,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
    size: (u32, u32),
}

/// One camera overlay's GPU resources.
struct CameraResources {
    camera: Quad,
    border: Option<Quad>,
    shadow: Option<Quad>,
}

struct MaskResources {
    binds: [wgpu::BindGroup; 2],
}

/// GPU resources for one composition pass at a fixed output size.
pub(super) struct Compositor {
    shared: Arc<SharedGpu>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    src_y: wgpu::Texture,
    src_uv: wgpu::Texture,
    _stage: [wgpu::Texture; 2],
    stage_views: [wgpu::TextureView; 2],
    params_full: wgpu::Buffer,
    params_sbs: wgpu::Buffer,
    params: FrameParams,
    out_buffer: wgpu::Buffer,
    render_bind_full: wgpu::BindGroup,
    render_bind_sbs: wgpu::BindGroup,
    compute_binds: [wgpu::BindGroup; 2],
    _layer_sampler: wgpu::Sampler,
    _mask_sampler: wgpu::Sampler,
    cursor: Option<Quad>,
    items: Option<Quad>,
    keys: Option<Quad>,
    cameras: Vec<CameraResources>,
    masks: Vec<MaskResources>,
    ring: Vec<RingSlot>,
    ring_next: usize,
    pending: VecDeque<Inflight>,
    /// The first frame handed back is checked for a degenerate (all-zero)
    /// result.
    checked_output: bool,
}

impl Compositor {
    /// Create a compositor at `width` × `height` for `frame`, reusing the
    /// process-wide device and pipelines when they are still healthy.
    pub(super) fn new(
        width: u32,
        height: u32,
        frame: &CanvasFrame,
        spec: &CompositorSpec,
    ) -> Result<Self> {
        if width == 0 || height == 0 || !width.is_multiple_of(4) || !height.is_multiple_of(2) {
            return Err(gpu_error(
                "GPU compositor needs an even canvas width divisible by 4",
            ));
        }
        let shared = shared_gpu()?;
        let device = shared.device.clone();
        let queue = shared.queue.clone();

        let src_y = create_plane(
            &device,
            width,
            height,
            wgpu::TextureFormat::R8Unorm,
            "gpu-export-y",
        );
        let src_uv = create_plane(
            &device,
            width / 2,
            height / 2,
            wgpu::TextureFormat::Rg8Unorm,
            "gpu-export-uv",
        );
        let src_y_view = src_y.create_view(&wgpu::TextureViewDescriptor::default());
        let src_uv_view = src_uv.create_view(&wgpu::TextureViewDescriptor::default());
        let full_background = match &frame.plate {
            Some(path) => Some(upload_plate(&device, &queue, path, width, height)?),
            None => None,
        };
        let sbs_background = match &frame.sbs_plate {
            Some(path) => Some(upload_plate(&device, &queue, path, width, height)?),
            None => None,
        };
        // A texture binding always has to exist; a 1×1 black texel stands in
        // when the shader is told to use the solid colour instead.
        let placeholder = placeholder_background(&device, &queue);
        let full_bg_view = full_background
            .as_ref()
            .unwrap_or(&placeholder)
            .create_view(&wgpu::TextureViewDescriptor::default());
        // The side-by-side slot falls back to the full plate when no
        // shadow-positioned plate exists (the background art is canvas-wide).
        let sbs_bg_source = sbs_background.as_ref().or(full_background.as_ref());
        let sbs_bg_view = sbs_bg_source
            .map(|texture| texture.create_view(&wgpu::TextureViewDescriptor::default()))
            .unwrap_or_else(|| placeholder.create_view(&wgpu::TextureViewDescriptor::default()));

        // Two RGBA16Float stages let a privacy-mask pass read one while writing
        // the other; every other layer draws into the current stage.
        let stage = std::array::from_fn(|index| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("gpu-export-stage-{index}")),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        });
        let stage_views = std::array::from_fn(|index| {
            stage[index].create_view(&wgpu::TextureViewDescriptor::default())
        });

        let full_plate = full_background.is_some();
        // The side-by-side bind group samples the shadow-positioned plate when
        // it exists and the canvas-wide plate otherwise, so "plate present"
        // covers either source.
        let sbs_plate = sbs_background.is_some() || full_plate;
        let params = FrameParams {
            canvas_size: [width as f32, height as f32, 0.0, 0.0],
            dest_rect: [
                frame.rect.0 as f32,
                frame.rect.1 as f32,
                frame.rect.2.max(1.0) as f32,
                frame.rect.3.max(1.0) as f32,
            ],
            crop: [0.0, 0.0, 1.0, 1.0],
            background: [
                frame.background[0],
                frame.background[1],
                frame.background[2],
                1.0 - f32::from(full_plate),
            ],
            corner: [frame.radius as f32, 0.0, 0.0, 0.0],
            source_rect: [
                frame.rect.0 as f32,
                frame.rect.1 as f32,
                frame.rect.2.max(1.0) as f32,
                frame.rect.3.max(1.0) as f32,
            ],
        };
        let mut sbs_params = params;
        sbs_params.background[3] = 1.0 - f32::from(sbs_plate);
        let params_full = create_uniform(&device, &queue, "gpu-export-frame-params", &params);
        let params_sbs =
            create_uniform(&device, &queue, "gpu-export-frame-params-sbs", &sbs_params);

        let nv12_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-export-nv12-params"),
            size: std::mem::size_of::<Nv12Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let out_len = nv12_len(width, height) as u64;
        let out_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-export-nv12"),
            size: out_len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let ring = (0..READBACK_RING)
            .map(|index| RingSlot {
                buffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("gpu-export-readback-{index}")),
                    size: out_len,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                mapped: None,
            })
            .collect();

        let layer_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("gpu-export-layer-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let mask_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("gpu-export-mask-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let render_bind = |params: &wgpu::Buffer, bg: &wgpu::TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("gpu-export-composite-bind"),
                layout: &shared.render_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&src_y_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&src_uv_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&layer_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(bg),
                    },
                ],
            })
        };
        let render_bind_full = render_bind(&params_full, &full_bg_view);
        let render_bind_sbs = render_bind(&params_sbs, &sbs_bg_view);

        let compute_binds = std::array::from_fn(|index| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("gpu-export-nv12-bind"),
                layout: &shared.compute_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&stage_views[index]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: out_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: nv12_buffer.as_entire_binding(),
                    },
                ],
            })
        });

        queue.write_buffer(
            &nv12_buffer,
            0,
            pod_bytes(&Nv12Params {
                width,
                height,
                y_words_per_row: width / 4,
                uv_word_offset: (width as usize * height as usize / 4) as u32,
            }),
        );

        let cursor = spec
            .cursor
            .map(|info| {
                Quad::planes(
                    &device,
                    &queue,
                    &shared,
                    &layer_sampler,
                    (width, height),
                    info.rect.2,
                    info.rect.3,
                    (0, 0),
                    "cursor",
                )
            })
            .transpose()?;
        let items = spec
            .items
            .map(|info| {
                Quad::planes(
                    &device,
                    &queue,
                    &shared,
                    &layer_sampler,
                    (width, height),
                    info.rect.2,
                    info.rect.3,
                    (info.rect.0, info.rect.1),
                    "items",
                )
            })
            .transpose()?;
        let keys = spec
            .keys
            .map(|info| {
                Quad::planes(
                    &device,
                    &queue,
                    &shared,
                    &layer_sampler,
                    (width, height),
                    info.rect.2,
                    info.rect.3,
                    (info.rect.0, info.rect.1),
                    "keys",
                )
            })
            .transpose()?;

        let mut cameras = Vec::with_capacity(spec.cameras.len());
        for (index, camera) in spec.cameras.iter().enumerate() {
            let camera_quad = Quad::nv12(
                &device,
                &queue,
                &shared,
                &layer_sampler,
                (width, height),
                camera.size.0,
                camera.size.1,
                camera.dest,
                camera.shape,
                camera.opacity,
                &format!("cam{index}"),
            )?;
            let border = camera
                .border
                .as_ref()
                .map(|bytes| {
                    Quad::rgba(
                        &device,
                        &queue,
                        &shared,
                        &layer_sampler,
                        (width, height),
                        bytes,
                        camera.size.0,
                        camera.size.1,
                        camera.dest,
                        Shape::Rect,
                        1.0,
                        &format!("cam{index}-border"),
                    )
                })
                .transpose()?;
            let shadow = camera
                .shadow
                .as_ref()
                .map(|(bytes, x, y)| {
                    let image = image::load_from_memory(bytes)
                        .map_err(|error| gpu_error(&format!("decode camera shadow: {error}")))?
                        .to_rgba8();
                    let (w, h) = image.dimensions();
                    Quad::rgba(
                        &device,
                        &queue,
                        &shared,
                        &layer_sampler,
                        (width, height),
                        image.as_raw(),
                        w,
                        h,
                        (*x, *y),
                        Shape::Rect,
                        1.0,
                        &format!("cam{index}-shadow"),
                    )
                })
                .transpose()?;
            cameras.push(CameraResources {
                camera: camera_quad,
                border,
                shadow,
            });
        }

        let masks = spec
            .masks
            .iter()
            .enumerate()
            .map(|(index, mask)| {
                let uniform = create_uniform(
                    &device,
                    &queue,
                    &format!("gpu-export-mask-{index}"),
                    &mask_params(mask),
                );
                let binds = std::array::from_fn(|stage| {
                    device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some(&format!("gpu-export-mask-{index}-bind-{stage}")),
                        layout: &shared.mask_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&stage_views[stage]),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(&mask_sampler),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: uniform.as_entire_binding(),
                            },
                        ],
                    })
                });
                MaskResources { binds }
            })
            .collect();

        let adapter_label = shared.adapter_label.clone();
        info!(
            adapter = %adapter_label,
            width,
            height,
            content = ?frame.rect,
            sbs = frame.sbs_rect.is_some(),
            radius = frame.radius,
            plate = frame.plate.is_some(),
            cursor = cursor.is_some(),
            items = items.is_some(),
            keys = keys.is_some(),
            cameras = cameras.len(),
            masks = spec.masks.len(),
            "gpu export: compositor ready"
        );

        Ok(Self {
            shared,
            device,
            queue,
            width,
            height,
            src_y,
            src_uv,
            _stage: stage,
            stage_views,
            params_full,
            params_sbs,
            params,
            out_buffer,
            render_bind_full,
            render_bind_sbs,
            compute_binds,
            _layer_sampler: layer_sampler,
            _mask_sampler: mask_sampler,
            cursor,
            items,
            keys,
            cameras,
            masks,
            ring,
            ring_next: 0,
            pending: VecDeque::with_capacity(READBACK_RING + 1),
            checked_output: false,
        })
    }

    pub(super) fn adapter_label(&self) -> &str {
        &self.shared.adapter_label
    }

    /// Submit one frame and return the frame that has been in flight longest.
    ///
    /// A [`Frame::Pass`] never touches the GPU, but it still travels through
    /// the queue so the returned order matches submission order. `Ok(None)`
    /// means nothing is ready yet (the pipeline is filling).
    pub(super) fn submit(
        &mut self,
        screen: Frame,
        request: FrameRequest,
    ) -> Result<Option<Vec<u8>>> {
        // Evict the oldest frame *before* reusing its readback buffer: the ring
        // cycles every `READBACK_RING` GPU submits, and a slot whose mapping was
        // never taken out is still mapped (a second `map_async` would fail).
        let ready = if self.pending.len() >= READBACK_RING {
            self.pop_ready()?
        } else {
            None
        };
        match screen {
            Frame::Pass(data) => self.pending.push_back(Inflight::Ready(data)),
            Frame::Compose(frame) => {
                if frame.data.len() != nv12_len(self.width, self.height) {
                    return Err(gpu_error("decoded frame size does not match the canvas"));
                }
                let slot = self.ring_next;
                self.ring_next = (self.ring_next + 1) % READBACK_RING;
                self.dispatch(frame, &request, slot)?;
                self.pending.push_back(Inflight::Gpu { slot });
            }
        }
        Ok(ready)
    }

    /// Drain the pipeline at end of stream.
    pub(super) fn drain(&mut self) -> Result<Vec<Vec<u8>>> {
        let mut frames = Vec::new();
        while !self.pending.is_empty() {
            if let Some(frame) = self.pop_ready()? {
                frames.push(frame);
            }
        }
        Ok(frames)
    }

    fn pop_ready(&mut self) -> Result<Option<Vec<u8>>> {
        match self.pending.pop_front() {
            None => Ok(None),
            Some(Inflight::Ready(data)) => Ok(Some(data)),
            Some(Inflight::Gpu { slot }) => {
                let data = self.read_back(slot)?;
                Ok(Some(data))
            }
        }
    }

    fn read_back(&mut self, slot: usize) -> Result<Vec<u8>> {
        let receiver = self.ring[slot]
            .mapped
            .take()
            .ok_or_else(|| gpu_error("GPU readback slot was not mapped"))?;
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| gpu_error(&format!("GPU readback poll failed: {error}")))?;
        match receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                return Err(gpu_error(&format!("GPU readback mapping failed: {error}")));
            }
            Err(_) => return Err(gpu_error("GPU readback was cancelled")),
        }
        let slice = self.ring[slot].buffer.slice(..);
        let data = slice
            .get_mapped_range()
            .map_err(|error| gpu_error(&format!("GPU readback failed: {error}")))?
            .to_vec();
        self.ring[slot].buffer.unmap();
        if self.shared.lost.load(Ordering::Relaxed) {
            return Err(gpu_error("GPU device was lost during composition"));
        }
        // An all-zero NV12 buffer is never a valid frame (limited range floors
        // luma at 16 and chroma at 16), so it means the dispatch wrote nothing.
        // Catch it on the first frame instead of shipping green frames.
        if !self.checked_output {
            self.checked_output = true;
            if data.iter().all(|byte| *byte == 0) {
                return Err(gpu_error(
                    "GPU compositor produced an empty frame; use the compatibility renderer",
                ));
            }
        }
        Ok(data)
    }

    fn dispatch(&mut self, frame: Nv12Frame, request: &FrameRequest, slot: usize) -> Result<()> {
        self.upload(&frame);
        // Drop the caller's buffer before the copy so only the plane textures
        // hold the decoded frame.
        drop(frame);

        let full = self.full_rect();
        let radius = self.radius_for(request, request.dest);
        self.params.dest_rect = [
            request.dest.0 as f32,
            request.dest.1 as f32,
            request.dest.2.max(1.0) as f32,
            request.dest.3.max(1.0) as f32,
        ];
        self.params.crop = [
            request.crop.x as f32 / full.2.max(1.0) as f32,
            request.crop.y as f32 / full.3.max(1.0) as f32,
            request.crop.width as f32 / full.2.max(1.0) as f32,
            request.crop.height as f32 / full.3.max(1.0) as f32,
        ];
        self.params.corner[0] = radius as f32;
        // The two bind groups keep their own plate-presence flag; only the
        // per-frame rect/crop/radius rows are rewritten here.
        let row = std::mem::size_of::<[f32; 4]>() as u64;
        for buffer in [&self.params_full, &self.params_sbs] {
            self.queue
                .write_buffer(buffer, row, pod_bytes(&self.params.dest_rect));
            self.queue
                .write_buffer(buffer, row * 2, pod_bytes(&self.params.crop));
            self.queue
                .write_buffer(buffer, row * 4, pod_bytes(&self.params.corner));
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gpu-export-frame"),
            });
        self.draw_canvas(&mut encoder, request);

        let mut stage = 0usize;
        if let Some(plane) = &request.cursor {
            self.upload_plane(PlaneKind::Cursor, plane)?;
        }
        if let (Some(cursor), Some(plane)) = (&self.cursor, &request.cursor) {
            self.write_quad_dest(
                cursor,
                (plane.dest.0, plane.dest.1, cursor.size.0, cursor.size.1),
            );
            self.draw_quad(&mut encoder, &self.stage_views[stage], cursor);
        }
        for camera in &request.cameras {
            self.upload_camera(camera.index, &camera.data)?;
            let Some(resources) = self.cameras.get(camera.index) else {
                continue;
            };
            if let Some(shadow) = &resources.shadow {
                self.draw_quad(&mut encoder, &self.stage_views[stage], shadow);
            }
            self.draw_quad(&mut encoder, &self.stage_views[stage], &resources.camera);
            if let Some(border) = &resources.border {
                self.draw_quad(&mut encoder, &self.stage_views[stage], border);
            }
        }
        for index in &request.masks {
            let Some(mask) = self.masks.get(*index) else {
                continue;
            };
            self.draw_mask(&mut encoder, stage, mask);
            stage = 1 - stage;
        }
        if let Some(plane) = &request.items {
            self.upload_plane(PlaneKind::Items, plane)?;
            if let Some(items) = &self.items {
                self.write_quad_dest(
                    items,
                    (plane.dest.0, plane.dest.1, items.size.0, items.size.1),
                );
                self.draw_quad(&mut encoder, &self.stage_views[stage], items);
            }
        }
        if let Some(plane) = &request.keys {
            self.upload_plane(PlaneKind::Keys, plane)?;
            if let Some(keys) = &self.keys {
                self.write_quad_dest(keys, (plane.dest.0, plane.dest.1, keys.size.0, keys.size.1));
                self.draw_quad(&mut encoder, &self.stage_views[stage], keys);
            }
        }

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gpu-export-nv12"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.shared.compute_pipeline);
            pass.set_bind_group(0, &self.compute_binds[stage], &[]);
            pass.dispatch_workgroups(
                self.width.div_ceil(4).div_ceil(16).max(1),
                self.height.div_ceil(16).max(1),
                1,
            );
        }
        let out_len = nv12_len(self.width, self.height) as u64;
        let target = &self.ring[slot];
        encoder.copy_buffer_to_buffer(&self.out_buffer, 0, &target.buffer, 0, out_len);
        self.queue.submit(Some(encoder.finish()));

        // Start the (async) map now so the copy-out lands while the next frame
        // is already being composed.
        let slice = target.buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.ring[slot].mapped = Some(receiver);
        Ok(())
    }

    fn full_rect(&self) -> (f64, f64, f64, f64) {
        // `source_rect` is written once at creation.
        let source = self.params.source_rect;
        (
            source[0] as f64,
            source[1] as f64,
            source[2] as f64,
            source[3] as f64,
        )
    }

    fn radius_for(&self, request: &FrameRequest, dest: (f64, f64, f64, f64)) -> u32 {
        let full = self.full_rect();
        if request.radius == 0 {
            return 0;
        }
        let scale = if full.2 > 0.0 {
            (dest.2 / full.2).clamp(0.0, 1.0)
        } else {
            1.0
        };
        ((request.radius as f64 * scale).round() as u32)
            .min((dest.2 / 2.0) as u32)
            .min((dest.3 / 2.0) as u32)
    }

    fn draw_canvas(&self, encoder: &mut wgpu::CommandEncoder, request: &FrameRequest) {
        let bind = if request.side_by_side {
            &self.render_bind_sbs
        } else {
            &self.render_bind_full
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("gpu-export-composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.stage_views[0],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.shared.render_pipeline);
        pass.set_bind_group(0, bind, &[]);
        pass.draw(0..3, 0..1);
    }

    fn draw_quad(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        quad: &Quad,
    ) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("gpu-export-layer"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.shared.layer_pipeline);
        pass.set_bind_group(0, &quad.bind, &[]);
        pass.draw(0..3, 0..1);
    }

    fn draw_mask(&self, encoder: &mut wgpu::CommandEncoder, stage: usize, mask: &MaskResources) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("gpu-export-mask"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.stage_views[1 - stage],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.shared.mask_pipeline);
        pass.set_bind_group(0, &mask.binds[stage], &[]);
        pass.draw(0..3, 0..1);
    }

    fn upload(&mut self, frame: &Nv12Frame) {
        let luma_len = self.width as usize * self.height as usize;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.src_y,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &frame.data[..luma_len],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(self.width),
                rows_per_image: Some(self.height),
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.src_uv,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &frame.data[luma_len..],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(self.width),
                rows_per_image: Some(self.height / 2),
            },
            wgpu::Extent3d {
                width: self.width / 2,
                height: self.height / 2,
                depth_or_array_layers: 1,
            },
        );
    }

    fn upload_plane(&mut self, kind: PlaneKind, plane: &PlaneFrame) -> Result<()> {
        let quad = match kind {
            PlaneKind::Cursor => self.cursor.as_mut(),
            PlaneKind::Items => self.items.as_mut(),
            PlaneKind::Keys => self.keys.as_mut(),
        };
        let Some(quad) = quad else {
            return Ok(());
        };
        let (w, h) = quad.size;
        let expected = crate::exports::cursor::yuva420p_len(w, h);
        if plane.data.len() != expected {
            return Err(gpu_error("generated overlay plane size does not match"));
        }
        let luma = w as usize * h as usize;
        let chroma = (w as usize / 2) * (h as usize / 2);
        write_plane(&self.queue, &quad.y, w, h, &plane.data[..luma]);
        // The generated plane is planar (U then V); the texture is interleaved
        // Rg8 so one sample yields both chroma components.
        let (u, v) = plane.data[luma..luma + chroma * 2].split_at(chroma);
        let mut uv = Vec::with_capacity(chroma * 2);
        for index in 0..chroma {
            uv.push(u[index]);
            uv.push(v[index]);
        }
        write_plane(&self.queue, &quad.uv, w / 2, h / 2, &uv);
        write_plane(&self.queue, &quad.a, w, h, &plane.data[luma + chroma * 2..]);
        Ok(())
    }

    fn upload_camera(&mut self, index: usize, data: &[u8]) -> Result<()> {
        let Some(resources) = self.cameras.get_mut(index) else {
            return Ok(());
        };
        let (w, h) = resources.camera.size;
        if data.len() != nv12_len(w, h) {
            return Err(gpu_error("camera frame size does not match the overlay"));
        }
        let luma = w as usize * h as usize;
        write_plane(&self.queue, &resources.camera.y, w, h, &data[..luma]);
        write_plane(
            &self.queue,
            &resources.camera.uv,
            w / 2,
            h / 2,
            &data[luma..],
        );
        Ok(())
    }

    fn write_quad_dest(&self, quad: &Quad, dest: (u32, u32, u32, u32)) {
        self.queue.write_buffer(
            &quad.uniform,
            (std::mem::size_of::<[f32; 4]>()) as u64,
            pod_bytes(&[
                dest.0 as f32,
                dest.1 as f32,
                dest.2.max(1) as f32,
                dest.3.max(1) as f32,
            ]),
        );
    }
}

/// Which generated plane a [`PlaneFrame`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PlaneKind {
    Cursor,
    Items,
    Keys,
}

fn mask_params(mask: &MaskConfig) -> MaskParams {
    let (mode, factor, color) = match mask.mode {
        MaskMode::Redact(color) => (0.0, 1.0, [color[0], color[1], color[2], 1.0]),
        MaskMode::Blur(factor) => (1.0, factor.max(1.0), [0.0, 0.0, 0.0, 0.0]),
        MaskMode::Pixelate(size) => (2.0, size.max(2.0), [0.0, 0.0, 0.0, 0.0]),
    };
    MaskParams {
        rect: [
            mask.rect.0 as f32,
            mask.rect.1 as f32,
            mask.rect.2.max(1) as f32,
            mask.rect.3.max(1) as f32,
        ],
        color,
        params: [mode, factor, 0.0, 0.0],
    }
}

fn create_uniform<T: bytemuck_free::Pod>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    value: &T,
) -> wgpu::Buffer {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: std::mem::size_of::<T>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, pod_bytes(value));
    buffer
}

impl Quad {
    #[allow(clippy::too_many_arguments)]
    fn planes(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        shared: &SharedGpu,
        sampler: &wgpu::Sampler,
        canvas: (u32, u32),
        width: u32,
        height: u32,
        dest: (u32, u32),
        label: &str,
    ) -> Result<Self> {
        let y = create_plane(
            device,
            width,
            height,
            wgpu::TextureFormat::R8Unorm,
            &format!("gpu-export-{label}-y"),
        );
        let uv = create_plane(
            device,
            width / 2,
            height / 2,
            wgpu::TextureFormat::Rg8Unorm,
            &format!("gpu-export-{label}-uv"),
        );
        let a = create_plane(
            device,
            width,
            height,
            wgpu::TextureFormat::R8Unorm,
            &format!("gpu-export-{label}-a"),
        );
        Self::finish(
            device,
            queue,
            shared,
            sampler,
            y,
            uv,
            a,
            canvas,
            (width, height),
            dest,
            Shape::Rect,
            1.0,
            1.0,
            label,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn nv12(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        shared: &SharedGpu,
        sampler: &wgpu::Sampler,
        canvas: (u32, u32),
        width: u32,
        height: u32,
        dest: (u32, u32),
        shape: Shape,
        opacity: f32,
        label: &str,
    ) -> Result<Self> {
        let y = create_plane(
            device,
            width,
            height,
            wgpu::TextureFormat::R8Unorm,
            &format!("gpu-export-{label}-y"),
        );
        let uv = create_plane(
            device,
            width / 2,
            height / 2,
            wgpu::TextureFormat::Rg8Unorm,
            &format!("gpu-export-{label}-uv"),
        );
        let a = placeholder_r8(device);
        Self::finish(
            device,
            queue,
            shared,
            sampler,
            y,
            uv,
            a,
            canvas,
            (width, height),
            dest,
            shape,
            opacity,
            0.0,
            label,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn rgba(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        shared: &SharedGpu,
        sampler: &wgpu::Sampler,
        canvas: (u32, u32),
        bytes: &[u8],
        width: u32,
        height: u32,
        dest: (u32, u32),
        shape: Shape,
        opacity: f32,
        label: &str,
    ) -> Result<Self> {
        let y = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("gpu-export-{label}-rgba")),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &y,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let uv = placeholder_rg8(device);
        let a = placeholder_r8(device);
        let quad = Self::finish(
            device,
            queue,
            shared,
            sampler,
            y,
            uv,
            a,
            canvas,
            (width, height),
            dest,
            shape,
            opacity,
            2.0,
            label,
        )?;
        Ok(quad)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        shared: &SharedGpu,
        sampler: &wgpu::Sampler,
        y: wgpu::Texture,
        uv: wgpu::Texture,
        a: wgpu::Texture,
        canvas: (u32, u32),
        size: (u32, u32),
        dest: (u32, u32),
        shape: Shape,
        opacity: f32,
        format: f32,
        label: &str,
    ) -> Result<Self> {
        let y_view = y.create_view(&wgpu::TextureViewDescriptor::default());
        let uv_view = uv.create_view(&wgpu::TextureViewDescriptor::default());
        let a_view = a.create_view(&wgpu::TextureViewDescriptor::default());
        let (kind, radius) = match shape {
            Shape::Rect => (0.0, 0.0),
            Shape::Circle => (1.0, 0.0),
            Shape::Rounded(radius) => (2.0, radius),
        };
        let params = LayerParams {
            canvas_size: [canvas.0 as f32, canvas.1 as f32, 0.0, 0.0],
            dest_rect: [dest.0 as f32, dest.1 as f32, size.0 as f32, size.1 as f32],
            shape: [kind, radius, 0.0, 0.0],
            opacity: [opacity, format, 0.0, 0.0],
        };
        let uniform = create_uniform(
            device,
            queue,
            &format!("gpu-export-{label}-params"),
            &params,
        );
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&format!("gpu-export-{label}-bind")),
            layout: &shared.layer_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&a_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        Ok(Self {
            y,
            uv,
            a,
            uniform,
            bind,
            size,
        })
    }
}

fn write_plane(queue: &wgpu::Queue, texture: &wgpu::Texture, width: u32, height: u32, data: &[u8]) {
    let format = texture.format();
    let bytes_per_row = match format {
        wgpu::TextureFormat::Rg8Unorm => width * 2,
        _ => width,
    };
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(bytes_per_row),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
}

/// Get the process-wide device, creating it on first use.
///
/// A cached device that reported a loss is dropped so the next export starts
/// clean; creating a device is slow but never wrong.
fn shared_gpu() -> Result<Arc<SharedGpu>> {
    let cache = SHARED_GPU.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !cache_enabled() {
        return create_shared_gpu().map(Arc::new);
    }
    if let Some(shared) = guard.as_ref() {
        if !shared.lost.load(Ordering::Relaxed) {
            return Ok(Arc::clone(shared));
        }
        warn!("gpu export: cached device was lost; rebuilding");
        *guard = None;
    }
    let created = Arc::new(create_shared_gpu()?);
    *guard = Some(Arc::clone(&created));
    Ok(created)
}

/// `RECORDFORGE_EXPORT_GPU_CACHE=0` disables the cache for A/B measurement.
fn cache_enabled() -> bool {
    !matches!(
        std::env::var("RECORDFORGE_EXPORT_GPU_CACHE").as_deref(),
        Ok("0") | Ok("false")
    )
}

fn create_shared_gpu() -> Result<SharedGpu> {
    let started = std::time::Instant::now();
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: preferred_backends(),
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter_started = std::time::Instant::now();
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .map_err(|error| gpu_error(&format!("no GPU adapter: {error}")))?;
    let adapter_ms = adapter_started.elapsed().as_millis() as u64;

    let info = adapter.get_info();
    let adapter_label = format!("{} ({:?})", info.name, info.backend);
    if !adapter_is_hardware(&info) {
        warn!(
            adapter = %adapter_label,
            "gpu export: refusing a software adapter"
        );
        return Err(gpu_error("GPU adapter is a software rasterizer"));
    }

    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("recordforge-export-compositor"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .map_err(|error| gpu_error(&format!("GPU device request failed: {error}")))?;
    let device_ms = started.elapsed().as_millis() as u64;

    device.on_uncaptured_error(Arc::new(|error| {
        // Never panic inside the export thread; device errors surface as a
        // lost device and the caller retries on the compatibility path.
        tracing::error!(detail = %format!("{error:?}"), "gpu export: uncaptured device error");
    }));
    let lost = Arc::new(AtomicBool::new(false));
    {
        let lost = Arc::clone(&lost);
        device.set_device_lost_callback(move |reason, message| {
            lost.store(true, Ordering::Relaxed);
            tracing::warn!(
                reason = ?reason,
                detail = %message.chars().take(200).collect::<String>(),
                "gpu export: device lost"
            );
        });
    }

    // Shader/pipeline creation failures are validation errors that would
    // otherwise only surface as silent garbage frames; capture them here so
    // the export can fall back to the compatibility renderer immediately.
    let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let composite_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gpu-export-composite"),
        source: wgpu::ShaderSource::Wgsl(COMPOSITE_WGSL.into()),
    });
    let layer_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gpu-export-layer"),
        source: wgpu::ShaderSource::Wgsl(LAYER_WGSL.into()),
    });
    let mask_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gpu-export-mask"),
        source: wgpu::ShaderSource::Wgsl(MASK_WGSL.into()),
    });
    let nv12_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gpu-export-nv12"),
        source: wgpu::ShaderSource::Wgsl(NV12_WGSL.into()),
    });
    let render_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gpu-export-composite-layout"),
        entries: &[
            texture_binding(0, wgpu::ShaderStages::FRAGMENT),
            texture_binding(1, wgpu::ShaderStages::FRAGMENT),
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            uniform_binding(3),
            texture_binding(4, wgpu::ShaderStages::FRAGMENT),
        ],
    });
    let compute_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gpu-export-nv12-layout"),
        entries: &[
            texture_binding(0, wgpu::ShaderStages::COMPUTE),
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            uniform_binding(2),
        ],
    });
    let layer_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gpu-export-layer-layout"),
        entries: &[
            texture_binding(0, wgpu::ShaderStages::FRAGMENT),
            texture_binding(1, wgpu::ShaderStages::FRAGMENT),
            texture_binding(2, wgpu::ShaderStages::FRAGMENT),
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            uniform_binding(4),
        ],
    });
    let mask_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gpu-export-mask-layout"),
        entries: &[
            texture_binding(0, wgpu::ShaderStages::FRAGMENT),
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            uniform_binding(2),
        ],
    });

    let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("gpu-export-composite-pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("gpu-export-composite-pipeline-layout"),
                bind_group_layouts: &[Some(&render_layout)],
                immediate_size: 0,
            }),
        ),
        vertex: wgpu::VertexState {
            module: &composite_module,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &composite_module,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let layer_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("gpu-export-layer-pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("gpu-export-layer-pipeline-layout"),
                bind_group_layouts: &[Some(&layer_layout)],
                immediate_size: 0,
            }),
        ),
        vertex: wgpu::VertexState {
            module: &layer_module,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &layer_module,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: Some(wgpu::BlendState {
                    color: wgpu::BlendComponent {
                        src_factor: wgpu::BlendFactor::One,
                        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                        operation: wgpu::BlendOperation::Add,
                    },
                    alpha: wgpu::BlendComponent {
                        src_factor: wgpu::BlendFactor::One,
                        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                        operation: wgpu::BlendOperation::Add,
                    },
                }),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let mask_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("gpu-export-mask-pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("gpu-export-mask-pipeline-layout"),
                bind_group_layouts: &[Some(&mask_layout)],
                immediate_size: 0,
            }),
        ),
        vertex: wgpu::VertexState {
            module: &mask_module,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &mask_module,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("gpu-export-nv12-pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("gpu-export-nv12-pipeline-layout"),
                bind_group_layouts: &[Some(&compute_layout)],
                immediate_size: 0,
            }),
        ),
        module: &nv12_module,
        entry_point: Some("cs_main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });

    if let Some(error) = block_on(error_scope.pop()) {
        return Err(gpu_error(&format!(
            "GPU compositor setup failed: {:?}",
            error
        )));
    }

    info!(
        adapter = %adapter_label,
        adapter_ms,
        device_ms,
        total_ms = started.elapsed().as_millis() as u64,
        "gpu export: device and pipelines ready"
    );

    Ok(SharedGpu {
        device,
        queue,
        adapter_label,
        lost,
        render_layout,
        compute_layout,
        layer_layout,
        mask_layout,
        render_pipeline,
        compute_pipeline,
        layer_pipeline,
        mask_pipeline,
    })
}

/// Upload a canvas-size background plate PNG (sRGB RGBA8) as a texture.
///
/// The plate is generated by `prepare_canvas_background_plate`, which already
/// bakes the colour/gradient/image, blur, dim and the canvas shadow, so the
/// compositor only has to sample it 1:1.
fn upload_plate(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    path: &std::path::Path,
    width: u32,
    height: u32,
) -> Result<wgpu::Texture> {
    let bytes = std::fs::read(path)
        .map_err(|error| gpu_error(&format!("read background plate: {error}")))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|error| gpu_error(&format!("decode background plate: {error}")))?
        .to_rgba8();
    let (image_w, image_h) = image.dimensions();
    if image_w != width || image_h != height {
        return Err(gpu_error("background plate is not canvas-sized"));
    }
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gpu-export-background"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        image.as_raw(),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    Ok(texture)
}

/// One opaque black texel: the bind group always needs a background texture,
/// and the shader ignores it whenever `background.a` says the colour is solid.
fn placeholder_background(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gpu-export-background-placeholder"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &[0u8, 0, 0, 255],
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn placeholder_r8(device: &wgpu::Device) -> wgpu::Texture {
    create_plane(device, 1, 1, wgpu::TextureFormat::R8Unorm, "gpu-export-r8")
}

fn placeholder_rg8(device: &wgpu::Device) -> wgpu::Texture {
    create_plane(
        device,
        1,
        1,
        wgpu::TextureFormat::Rg8Unorm,
        "gpu-export-rg8",
    )
}

fn create_plane(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    label: &str,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn texture_binding(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn uniform_binding(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// Backends to probe for the export compositor.
///
/// One native backend per platform: enumerating every backend at once
/// (`Backends::PRIMARY`) initialises DXGI, Vulkan *and* GLES, which costs
/// seconds on a laptop with hybrid graphics before the first frame is composited.
/// `WGPU_BACKEND` still overrides for debugging.
fn preferred_backends() -> wgpu::Backends {
    if let Some(backends) = wgpu::Backends::from_env() {
        return backends;
    }
    #[cfg(target_os = "windows")]
    {
        wgpu::Backends::DX12
    }
    #[cfg(target_os = "macos")]
    {
        wgpu::Backends::METAL
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        wgpu::Backends::VULKAN | wgpu::Backends::GL
    }
}

/// Reject software rasterizers: shipping export frames through WARP/llvmpipe is
/// slower than the FFmpeg graph it replaces.
fn adapter_is_hardware(info: &wgpu::AdapterInfo) -> bool {
    if info.device_type == wgpu::DeviceType::Cpu {
        return false;
    }
    let name = info.name.to_ascii_lowercase();
    !name.contains("basic render driver")
        && !name.contains("llvmpipe")
        && !name.contains("swiftshader")
        && !name.contains("software")
}

fn pod_bytes<T: bytemuck_free::Pod>(value: &T) -> &[u8] {
    // Safety: `Pod` guarantees the value is valid for any bit pattern and has
    // no padding, so its bytes are a valid `u8` slice.
    unsafe { std::slice::from_raw_parts(value as *const T as *const u8, std::mem::size_of::<T>()) }
}

/// wgpu's adapter/device requests are futures; the export runs on a plain
/// thread, so park the thread until the waker runs.
pub(super) fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::sync::Arc as StdArc;
    use std::task::{Context, Poll, Wake, Waker};

    struct ThreadWaker(std::thread::Thread);
    impl Wake for ThreadWaker {
        fn wake(self: StdArc<Self>) {
            self.0.unpark();
        }
    }

    let waker = Waker::from(StdArc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic NV12 frame with a monotone per-column luma ramp and
    /// neutral chroma. A ramp is linear, so the Catmull-Rom sampler must
    /// reproduce it exactly — which makes it a precise probe for *where* each
    /// output pixel was sampled.
    fn ramp_frame(width: u32, height: u32) -> Nv12Frame {
        let luma = width as usize * height as usize;
        let mut data = vec![128u8; nv12_len(width, height)];
        for y in 0..height as usize {
            for x in 0..width as usize {
                data[y * width as usize + x] = 16 + (x / 8) as u8;
            }
        }
        for byte in data[luma..].chunks_mut(2) {
            byte[0] = 128;
            byte[1] = 128;
        }
        Nv12Frame { data }
    }

    /// NV12 frame with flat luma and two vertical chroma blocks, so a sample
    /// can assert the chroma geometry without interpolation ringing.
    fn chroma_block_frame(width: u32, height: u32) -> Nv12Frame {
        let luma = width as usize * height as usize;
        let mut data = vec![128u8; nv12_len(width, height)];
        data[..luma].fill(128);
        for row in 0..height as usize / 2 {
            for col in 0..width as usize / 2 {
                let index = luma + row * width as usize + col * 2;
                data[index] = if col < width as usize / 4 { 64 } else { 192 };
                data[index + 1] = 128;
            }
        }
        Nv12Frame { data }
    }

    /// A canvas frame that fills the whole canvas with square corners and an
    /// opaque black background.
    fn plain_frame(width: u32, height: u32) -> CanvasFrame {
        CanvasFrame {
            rect: (0.0, 0.0, width as f64, height as f64),
            sbs_rect: None,
            sbs_windows: Vec::new(),
            radius: 0,
            background: [0.0, 0.0, 0.0],
            plate: None,
            sbs_plate: None,
        }
    }

    /// Compositor tests need a hardware adapter; a machine without one (CI,
    /// headless) skips rather than failing the suite.
    fn compositor(width: u32, height: u32) -> Option<Compositor> {
        compositor_for(width, height, plain_frame(width, height))
    }

    fn compositor_for(width: u32, height: u32, frame: CanvasFrame) -> Option<Compositor> {
        match Compositor::new(width, height, &frame, &CompositorSpec::default()) {
            Ok(compositor) => Some(compositor),
            Err(error) => {
                eprintln!("skipping GPU compositor test: {error}");
                None
            }
        }
    }

    fn request(width: u32, height: u32, crop: Crop) -> FrameRequest {
        FrameRequest {
            crop,
            dest: (0.0, 0.0, width as f64, height as f64),
            radius: 0,
            side_by_side: false,
            cursor: None,
            items: None,
            keys: None,
            cameras: Vec::new(),
            masks: Vec::new(),
        }
    }

    /// Submit one frame through the pipelined API and return its finished NV12
    /// bytes. Tests run the ring dry rather than asserting pipeline depth.
    fn compose_one(
        compositor: &mut Compositor,
        width: u32,
        height: u32,
        frame: Nv12Frame,
        crop: Crop,
    ) -> Vec<u8> {
        assert!(
            compositor
                .submit(Frame::Compose(frame), request(width, height, crop))
                .expect("submit")
                .is_none(),
            "the first frame must stay in flight"
        );
        let frames = compositor.drain().expect("drain");
        assert_eq!(frames.len(), 1, "one frame in, one frame out");
        frames.into_iter().next().unwrap()
    }

    fn luma_row(data: &[u8], width: u32, row: u32) -> &[u8] {
        let start = row as usize * width as usize;
        &data[start..start + width as usize]
    }

    fn assert_row_close(
        actual: &[u8],
        expected: impl Fn(usize) -> f32,
        tolerance: i16,
        label: &str,
    ) {
        for (index, got) in actual.iter().enumerate() {
            let want = expected(index);
            assert!(
                (want - *got as f32).abs() <= tolerance as f32,
                "{label} luma mismatch at x={index}: want {want:.1} got {got}"
            );
        }
    }

    #[test]
    fn identity_crop_reproduces_the_source_luma() {
        let (width, height) = (320, 64);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let out = compose_one(
            &mut compositor,
            width,
            height,
            ramp_frame(width, height),
            Crop {
                x: 0,
                y: 0,
                width,
                height,
            },
        );
        // Identity sampling must be exact: output x reads source texel x.
        assert_row_close(
            luma_row(&out, width, 32),
            |x| 16.0 + (x / 8) as f32,
            1,
            "identity",
        );
    }

    #[test]
    fn half_width_crop_samples_the_requested_region() {
        let (width, height) = (320, 64);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let out = compose_one(
            &mut compositor,
            width,
            height,
            ramp_frame(width, height),
            Crop {
                x: 160,
                y: 0,
                width: 160,
                height: 64,
            },
        );
        // A 160-wide crop scaled back to 320 samples source 160 + x/2.
        assert_row_close(
            luma_row(&out, width, 32),
            |x| 16.0 + (160.0 + x as f32 / 2.0) / 8.0,
            1,
            "crop",
        );
    }

    #[test]
    fn canvas_size_quarter_crop_samples_the_requested_region() {
        let (width, height) = (1920, 1080);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let out = compose_one(
            &mut compositor,
            width,
            height,
            ramp_frame(width, height),
            Crop {
                x: 480,
                y: 270,
                width: 960,
                height: 540,
            },
        );
        // A 960-wide crop scaled back to 1920 samples source 480 + x/2.
        assert_row_close(
            luma_row(&out, width, 540),
            |x| 16.0 + (480.0 + x as f32 / 2.0) / 8.0,
            1,
            "canvas crop",
        );
    }

    #[test]
    fn quarter_crop_maps_the_chroma_block_boundary() {
        let (width, height) = (1920, 1080);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let out = compose_one(
            &mut compositor,
            width,
            height,
            chroma_block_frame(width, height),
            Crop {
                x: 480,
                y: 270,
                width: 960,
                height: 540,
            },
        );
        let luma_len = width as usize * height as usize;
        let uv_row_start = luma_len + 270 * width as usize;
        let u_col = |col: usize| out[uv_row_start + col * 2];
        // The block edge sits at source chroma column 480, i.e. source luma
        // x = 960. The crop samples chroma 240..720, so the edge lands inside
        // the output and must not move.
        let first_high = (0..width as usize / 2)
            .find(|col| u_col(*col) > 128)
            .expect("a bright chroma block");
        assert!(
            (first_high as i32 - 480).abs() <= 4,
            "chroma block edge at {first_high}, expected 480"
        );
        assert!(u_col(0) < 80, "left of the crop must stay on the low block");
        assert!(
            u_col(width as usize / 2 - 1) > 176,
            "right of the crop must stay on the high block"
        );
    }

    /// A flat-luma NV12 frame; `value` survives the YUV round trip.
    fn flat_frame(width: u32, height: u32, value: u8) -> Nv12Frame {
        let luma = width as usize * height as usize;
        let mut data = vec![128u8; nv12_len(width, height)];
        data[..luma].fill(value);
        Nv12Frame { data }
    }

    #[test]
    fn padded_content_shows_the_background_and_rounded_corners() {
        let (width, height) = (64, 32);
        let frame = CanvasFrame {
            rect: (8.0, 4.0, 48.0, 24.0),
            radius: 8,
            ..plain_frame(width, height)
        };
        let Some(mut compositor) = compositor_for(width, height, frame) else {
            return;
        };
        let mut req = request(
            width,
            height,
            Crop {
                x: 0,
                y: 0,
                width: 48,
                height: 24,
            },
        );
        req.dest = (8.0, 4.0, 48.0, 24.0);
        req.radius = 8;
        compositor
            .submit(Frame::Compose(flat_frame(width, height, 200)), req)
            .expect("submit");
        let out = compositor.drain().expect("drain").remove(0);
        let luma = |x: u32, y: u32| out[y as usize * width as usize + x as usize] as i16;
        // Padding: black background (limited-range floor is 16).
        assert!(luma(0, 0) <= 20, "padding luma {}", luma(0, 0));
        assert!(luma(4, 16) <= 20, "left padding luma {}", luma(4, 16));
        // Content: the flat 200 survives.
        assert!(
            (luma(32, 16) - 200).abs() <= 2,
            "content luma {}",
            luma(32, 16)
        );
        // The corner of the content rect is rounded away, so the background
        // shows through even though the pixel is inside the bounding box.
        assert!(luma(9, 5) <= 40, "corner luma {}", luma(9, 5));
        // Just inside the straight edge, well past the radius: content.
        assert!(
            (luma(32, 5) - 200).abs() <= 3,
            "top edge luma {}",
            luma(32, 5)
        );
    }

    #[test]
    fn side_by_side_dest_draws_the_full_picture_into_the_smaller_slot() {
        let (width, height) = (64, 32);
        let frame = CanvasFrame {
            rect: (0.0, 0.0, 64.0, 32.0),
            sbs_rect: Some((4.0, 4.0, 32.0, 16.0)),
            sbs_windows: vec![(0, 1_000)],
            ..plain_frame(width, height)
        };
        let Some(mut compositor) = compositor_for(width, height, frame) else {
            return;
        };
        let mut req = request(
            width,
            height,
            Crop {
                x: 0,
                y: 0,
                width: 64,
                height: 32,
            },
        );
        req.side_by_side = true;
        req.dest = (4.0, 4.0, 32.0, 16.0);
        compositor
            .submit(Frame::Compose(flat_frame(width, height, 200)), req)
            .expect("submit");
        let out = compositor.drain().expect("drain").remove(0);
        let luma = |x: u32, y: u32| out[y as usize * width as usize + x as usize] as i16;
        assert!(
            (luma(20, 12) - 200).abs() <= 3,
            "slot luma {}",
            luma(20, 12)
        );
        assert!(luma(56, 24) <= 20, "outside slot luma {}", luma(56, 24));
    }

    #[test]
    fn redact_mask_paints_only_its_rect() {
        let (width, height) = (64, 32);
        let spec = CompositorSpec {
            masks: vec![MaskConfig {
                rect: (16, 8, 16, 12),
                mode: MaskMode::Redact([1.0, 0.0, 0.0]),
            }],
            ..Default::default()
        };
        let Some(mut compositor) =
            Compositor::new(width, height, &plain_frame(width, height), &spec).ok()
        else {
            return;
        };
        let mut req = request(
            width,
            height,
            Crop {
                x: 0,
                y: 0,
                width,
                height,
            },
        );
        req.masks.push(0);
        compositor
            .submit(Frame::Compose(flat_frame(width, height, 200)), req)
            .expect("submit");
        let out = compositor.drain().expect("drain").remove(0);
        let luma = |x: u32, y: u32| out[y as usize * width as usize + x as usize] as i16;
        let u = |x: u32, y: u32| {
            out[width as usize * height as usize
                + (y as usize / 2) * width as usize
                + (x as usize / 2) * 2] as i16
        };
        // Red inside the rect (BT.601 red is ~81 luma, U ~90).
        assert!((luma(24, 14) - 81).abs() <= 12, "red luma {}", luma(24, 14));
        assert!((u(24, 14) - 90).abs() <= 20, "red U {}", u(24, 14));
        // Untouched outside.
        assert!(
            (luma(4, 14) - 200).abs() <= 3,
            "outside luma {}",
            luma(4, 14)
        );
    }

    #[test]
    fn pixelate_mask_blocks_the_ramp_into_equal_cells() {
        let (width, height) = (64, 32);
        let spec = CompositorSpec {
            masks: vec![MaskConfig {
                rect: (0, 0, 64, 32),
                mode: MaskMode::Pixelate(8.0),
            }],
            ..Default::default()
        };
        let Some(mut compositor) =
            Compositor::new(width, height, &plain_frame(width, height), &spec).ok()
        else {
            return;
        };
        let mut req = request(
            width,
            height,
            Crop {
                x: 0,
                y: 0,
                width,
                height,
            },
        );
        req.masks.push(0);
        compositor
            .submit(Frame::Compose(ramp_frame(width, height)), req)
            .expect("submit");
        let out = compositor.drain().expect("drain").remove(0);
        let luma = |x: u32, y: u32| out[y as usize * width as usize + x as usize];
        // Each 8-px cell samples the block centre, so a whole cell is flat.
        assert_eq!(luma(0, 4), luma(7, 4), "pixelate cell is not flat");
        assert_ne!(luma(4, 4), luma(20, 4), "pixelate cells did not move");
    }

    #[test]
    fn cursor_plane_composites_at_its_per_frame_origin() {
        let (width, height) = (64, 32);
        let spec = CompositorSpec {
            cursor: Some(PlaneInfo {
                rect: (0, 0, 16, 16),
            }),
            ..Default::default()
        };
        let Some(mut compositor) =
            Compositor::new(width, height, &plain_frame(width, height), &spec).ok()
        else {
            return;
        };
        // Opaque white tile, every plane byte at full value (white Y, neutral
        // UV, opaque alpha).
        let tile = 16u32;
        let luma = (tile * tile) as usize;
        let chroma = (tile as usize / 2) * (tile as usize / 2);
        let mut data = vec![235u8; luma];
        data.extend(std::iter::repeat_n(128u8, chroma * 2));
        data.extend(std::iter::repeat_n(255u8, luma));
        let mut req = request(
            width,
            height,
            Crop {
                x: 0,
                y: 0,
                width,
                height,
            },
        );
        req.cursor = Some(PlaneFrame {
            data: std::sync::Arc::new(data),
            dest: (32, 16),
        });
        compositor
            .submit(Frame::Compose(flat_frame(width, height, 100)), req)
            .expect("submit");
        let out = compositor.drain().expect("drain").remove(0);
        let luma_at = |x: u32, y: u32| out[y as usize * width as usize + x as usize] as i16;
        assert!(
            (luma_at(36, 20) - 235).abs() <= 3,
            "cursor luma {}",
            luma_at(36, 20)
        );
        assert!(
            (luma_at(4, 4) - 100).abs() <= 3,
            "background luma {}",
            luma_at(4, 4)
        );
    }

    #[test]
    fn ring_reuse_returns_every_frame_once_in_order() {
        let (width, height) = (64, 32);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let crop = Crop {
            x: 0,
            y: 0,
            width,
            height,
        };
        let total = READBACK_RING * 3;
        let mut out = Vec::new();
        for index in 0..total {
            let value = 40 + index as u8 * 10;
            out.extend(
                compositor
                    .submit(
                        Frame::Compose(flat_frame(width, height, value)),
                        request(width, height, crop),
                    )
                    .expect("submit"),
            );
        }
        out.extend(compositor.drain().expect("drain"));
        assert_eq!(out.len(), total, "every submitted frame is emitted once");
        for (index, frame) in out.iter().enumerate() {
            let want = 40 + index as u8 * 10;
            assert!(
                (frame[0] as i16 - want as i16).abs() <= 1,
                "frame {index} luma {} != {want}",
                frame[0]
            );
        }
    }

    #[test]
    fn pass_frames_keep_their_place_in_the_readback_queue() {
        let (width, height) = (320, 64);
        let Some(mut compositor) = compositor(width, height) else {
            return;
        };
        let crop = Crop {
            x: 0,
            y: 0,
            width,
            height,
        };
        // Fill the ring, then interleave a bypass frame and one more compose:
        // output order must match submission order.
        let mut ready: Vec<Vec<u8>> = Vec::new();
        for _ in 0..READBACK_RING {
            ready.extend(
                compositor
                    .submit(
                        Frame::Compose(ramp_frame(width, height)),
                        request(width, height, crop),
                    )
                    .expect("submit"),
            );
        }
        ready.extend(
            compositor
                .submit(Frame::Pass(vec![7; 16]), request(width, height, crop))
                .expect("bypass"),
        );
        ready.extend(
            compositor
                .submit(
                    Frame::Compose(ramp_frame(width, height)),
                    request(width, height, crop),
                )
                .expect("submit"),
        );
        ready.extend(compositor.drain().expect("drain"));
        assert_eq!(ready.len(), READBACK_RING + 2);
        assert_eq!(ready[READBACK_RING], vec![7; 16], "bypass payload in order");
        assert_eq!(
            ready[0].len(),
            nv12_len(width, height),
            "composed frames carry a full NV12 canvas"
        );
    }
}
