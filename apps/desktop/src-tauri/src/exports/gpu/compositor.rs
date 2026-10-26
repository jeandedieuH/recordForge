//! wgpu side of the native export compositor.
//!
//! The compositor owns one GPU device and the fixed set of resources a
//! composition pass needs: an NV12 screen plane pair, an RGBA render target
//! (the composed canvas), and NV12 output buffers that are read back on the
//! CPU and handed straight to the encode sidecar's stdin.
//!
//! The device, adapter and pipelines are **process-wide**: creating them costs
//! ~2–3 s (adapter probe, DX12 device, naga/FXC shader compile), which is a
//! large share of a short export. Only size-dependent resources (planes, render
//! target, readback ring) are per export.
//!
//! Readback is pipelined through a ring of host-visible buffers: submitting a
//! frame hands back the frame that has been on the GPU longest, so the GPU
//! keeps working while the CPU copies and writes the previous one.
//!
//! Only the parts of the FFmpeg graph that G0 covers run here: the screen plane
//! with a zoom crop and the BT.601 colour round trip. Cursor, camera, items,
//! masks, captions and the canvas frame/wrapper are gated out by
//! [`super::plan_limitations`] until their milestones land.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::errors::Result;
use tracing::{info, warn};

use super::gpu_error;

const COMPOSITE_WGSL: &str = include_str!("shaders/composite.wgsl");
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
    /// Composite it through the GPU (zoom is not the identity).
    Compose(Nv12Frame),
    /// Forward the decoder's bytes untouched (identity zoom).
    Pass(Vec<u8>),
}

/// Canvas framing for one export: where the screen content sits, how round its
/// corners are, and what shows through around it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct CanvasFrame {
    /// Content rect on the canvas, in canvas pixels: `(x, y, w, h)`.
    pub rect: (f64, f64, f64, f64),
    /// Rounded corner radius in canvas pixels (0 = square).
    pub radius: u32,
    /// Solid background colour as sRGB floats, used when `plate` is `None`.
    pub background: [f32; 3],
    /// Canvas-size RGBA background plate (colour, gradient, image, blur, dim
    /// and the canvas shadow are all baked in by `prepare_canvas_background_plate`).
    pub plate: Option<std::path::PathBuf>,
}

impl CanvasFrame {
    /// True when the screen covers the whole canvas with square corners and no
    /// background is visible, so an identity-zoom frame needs no compositing.
    pub(super) fn is_plain(&self, width: u32, height: u32) -> bool {
        self.plate.is_none()
            && self.radius == 0
            && self.rect.0.abs() < 0.5
            && self.rect.1.abs() < 0.5
            && self.rect.2 >= width as f64 - 0.5
            && self.rect.3 >= height as f64 - 0.5
    }
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
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Nv12Params {
    width: u32,
    height: u32,
    y_words_per_row: u32,
    uv_word_offset: u32,
}

/// Minimal `Pod` substitute so the crate does not take a `bytemuck` dependency
/// for its uniform structs. Safety: both types are `#[repr(C)]`, made entirely
/// of `u32`/`f32`, and contain no padding.
mod bytemuck_free {
    /// # Safety
    /// Implementors must be plain-old-data: `#[repr(C)]`, no padding, no
    /// pointers, and valid for any bit pattern.
    pub unsafe trait Pod: Copy {}
    unsafe impl Pod for super::FrameParams {}
    unsafe impl Pod for super::Nv12Params {}
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
    render_pipeline: wgpu::RenderPipeline,
    compute_pipeline: wgpu::ComputePipeline,
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

/// GPU resources for one composition pass at a fixed output size.
pub(super) struct Compositor {
    shared: Arc<SharedGpu>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    src_y: wgpu::Texture,
    src_uv: wgpu::Texture,
    stage_view: wgpu::TextureView,
    zoom_buffer: wgpu::Buffer,
    out_buffer: wgpu::Buffer,
    render_bind_group: wgpu::BindGroup,
    compute_bind_group: wgpu::BindGroup,
    ring: Vec<RingSlot>,
    ring_next: usize,
    pending: VecDeque<Inflight>,
    /// Counts frames submitted to the GPU, for the ring index.
    submitted: u64,
    /// The first frame handed back is checked for a degenerate (all-zero)
    /// result.
    checked_output: bool,
}

impl Compositor {
    /// Create a compositor at `width` × `height`, reusing the process-wide
    /// device and pipelines when they are still healthy.
    pub(super) fn new(width: u32, height: u32) -> Result<Self> {
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

        // The composed canvas stays in `Rgba16Float` so the YUV→RGB→YUV round
        // trip quantizes once (at the NV12 write) instead of twice.
        let stage = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("gpu-export-stage"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let stage_view = stage.create_view(&wgpu::TextureViewDescriptor::default());

        let zoom_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-export-zoom"),
            size: std::mem::size_of::<ZoomUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-export-params"),
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

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("gpu-export-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let render_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
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
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: zoom_buffer.as_entire_binding(),
                },
            ],
        });
        let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gpu-export-nv12-bind"),
            layout: &shared.compute_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&stage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: out_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: params_buffer.as_entire_binding(),
                },
            ],
        });

        queue.write_buffer(
            &params_buffer,
            0,
            pod_bytes(&Nv12Params {
                width,
                height,
                y_words_per_row: width / 4,
                uv_word_offset: (width as usize * height as usize / 4) as u32,
            }),
        );

        let adapter_label = shared.adapter_label.clone();
        info!(
            adapter = %adapter_label,
            width,
            height,
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
            stage_view,
            zoom_buffer,
            out_buffer,
            render_bind_group,
            compute_bind_group,
            ring,
            ring_next: 0,
            pending: VecDeque::with_capacity(READBACK_RING + 1),
            submitted: 0,
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
    pub(super) fn submit(&mut self, frame: Frame, crop: Crop) -> Result<Option<Vec<u8>>> {
        // Evict the oldest frame *before* reusing its readback buffer: the ring
        // cycles every `READBACK_RING` GPU submits, and a slot whose mapping was
        // never taken out is still mapped (a second `map_async` would fail).
        let ready = if self.pending.len() >= READBACK_RING {
            self.pop_ready()?
        } else {
            None
        };
        match frame {
            Frame::Compose(frame) => {
                if frame.data.len() != nv12_len(self.width, self.height) {
                    return Err(gpu_error("decoded frame size does not match the canvas"));
                }
                let slot = self.ring_next;
                self.ring_next = (self.ring_next + 1) % READBACK_RING;
                self.dispatch(frame, crop, slot)?;
                self.pending.push_back(Inflight::Gpu { slot });
            }
            Frame::Pass(data) => self.pending.push_back(Inflight::Ready(data)),
        }
        self.submitted += 1;
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

    fn dispatch(&mut self, frame: Nv12Frame, crop: Crop, slot: usize) -> Result<()> {
        self.upload(&frame);
        // Drop the caller's buffer before the copy so only the plane textures
        // hold the decoded frame.
        drop(frame);
        self.queue.write_buffer(
            &self.zoom_buffer,
            0,
            pod_bytes(&ZoomUniform {
                crop: [
                    crop.x as f32 / self.width as f32,
                    crop.y as f32 / self.height as f32,
                    crop.width as f32 / self.width as f32,
                    crop.height as f32 / self.height as f32,
                ],
            }),
        );

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gpu-export-frame"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("gpu-export-composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.stage_view,
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
            pass.set_bind_group(0, &self.render_bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gpu-export-nv12"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.shared.compute_pipeline);
            pass.set_bind_group(0, &self.compute_bind_group, &[]);
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

    pub(super) fn upload(&mut self, frame: &Nv12Frame) {
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
        render_pipeline,
        compute_pipeline,
    })
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

    /// Compositor tests need a hardware adapter; a machine without one (CI,
    /// headless) skips rather than failing the suite.
    fn compositor(width: u32, height: u32) -> Option<Compositor> {
        match Compositor::new(width, height) {
            Ok(compositor) => Some(compositor),
            Err(error) => {
                eprintln!("skipping GPU compositor test: {error}");
                None
            }
        }
    }

    /// Submit one frame through the pipelined API and return its finished NV12
    /// bytes. Tests run the ring dry rather than asserting pipeline depth.
    fn compose_one(compositor: &mut Compositor, frame: Nv12Frame, crop: Crop) -> Vec<u8> {
        assert!(
            compositor
                .submit(Frame::Compose(frame), crop)
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
        // Flat luma per frame identifies it after the whole YUV round trip.
        let flat = |value: u8| {
            let luma = width as usize * height as usize;
            let mut data = vec![128u8; nv12_len(width, height)];
            data[..luma].fill(value);
            Nv12Frame { data }
        };
        let total = READBACK_RING * 3;
        let mut out = Vec::new();
        for index in 0..total {
            let value = 40 + index as u8 * 10;
            out.extend(
                compositor
                    .submit(Frame::Compose(flat(value)), crop)
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
                    .submit(Frame::Compose(ramp_frame(width, height)), crop)
                    .expect("submit"),
            );
        }
        ready.extend(
            compositor
                .submit(Frame::Pass(vec![7; 16]), crop)
                .expect("bypass"),
        );
        ready.extend(
            compositor
                .submit(Frame::Compose(ramp_frame(width, height)), crop)
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
