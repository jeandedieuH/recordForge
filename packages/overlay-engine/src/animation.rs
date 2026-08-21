use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayAnimationType {
    None,
    #[default]
    Fade,
    ScaleUp,
    ScaleDown,
    SlideUp,
    SlideDown,
    SlideLeft,
    SlideRight,
    PopIn,
    Bounce,
    Draw,
    Typewriter,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayAnimationOutType {
    None,
    #[default]
    Fade,
    ScaleUp,
    ScaleDown,
    SlideUp,
    SlideDown,
    SlideLeft,
    SlideRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayAnimation {
    pub in_type: OverlayAnimationType,
    pub out_type: OverlayAnimationOutType,
    pub in_duration_ms: u64,
    pub out_duration_ms: u64,
    pub easing: OverlayEasing,
}

impl Default for OverlayAnimation {
    fn default() -> Self {
        Self {
            in_type: OverlayAnimationType::Fade,
            out_type: OverlayAnimationOutType::Fade,
            in_duration_ms: 350,
            out_duration_ms: 350,
            easing: OverlayEasing::ExpoOut,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverlayAnimationFrame {
    /// Progress through the active transition, or 1 while the item is held.
    pub progress: f64,
    /// Opacity multiplier contributed by the active transition.
    pub opacity: f64,
    /// Uniform scale multiplier contributed by the active transition.
    pub scale: f64,
    /// Translation contributed by the active transition in canvas pixels.
    pub translate_x: f64,
    pub translate_y: f64,
    /// Progressive reveal values consumed by annotation and text adapters.
    pub draw_progress: f64,
    pub text_progress: f64,
}

impl Default for OverlayAnimationFrame {
    fn default() -> Self {
        Self::visible()
    }
}

impl OverlayAnimationFrame {
    fn visible() -> Self {
        Self {
            progress: 1.0,
            opacity: 1.0,
            scale: 1.0,
            translate_x: 0.0,
            translate_y: 0.0,
            draw_progress: 1.0,
            text_progress: 1.0,
        }
    }

    fn hidden() -> Self {
        Self {
            progress: 0.0,
            opacity: 0.0,
            scale: 1.0,
            translate_x: 0.0,
            translate_y: 0.0,
            draw_progress: 0.0,
            text_progress: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayEasing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    #[default]
    ExpoOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnimationPhase {
    In,
    Out,
}

/// Evaluate all time-dependent effects for one overlay item.
///
/// Transition durations are proportionally shortened when their combined
/// duration is longer than the clip. This keeps short clips deterministic and
/// prevents entrance and exit animations from competing for the same frame.
pub fn animation_at(
    animation: &OverlayAnimation,
    time_ms: u64,
    start_ms: u64,
    end_ms: u64,
    width: f64,
    height: f64,
) -> OverlayAnimationFrame {
    if time_ms < start_ms || time_ms >= end_ms {
        return OverlayAnimationFrame::hidden();
    }

    let clip_duration_ms = end_ms.saturating_sub(start_ms) as f64;
    let (in_duration_ms, out_duration_ms) = effective_durations(animation, clip_duration_ms);
    let elapsed_ms = time_ms.saturating_sub(start_ms) as f64;
    let remaining_ms = end_ms.saturating_sub(time_ms) as f64;

    let (phase, raw_progress) = if in_duration_ms > 0.0 && elapsed_ms < in_duration_ms {
        (AnimationPhase::In, elapsed_ms / in_duration_ms)
    } else if out_duration_ms > 0.0 && remaining_ms <= out_duration_ms {
        (
            AnimationPhase::Out,
            (out_duration_ms - remaining_ms) / out_duration_ms,
        )
    } else {
        return OverlayAnimationFrame::visible();
    };

    let progress = eased_progress(animation.easing, raw_progress);
    let mut frame = OverlayAnimationFrame {
        progress,
        ..OverlayAnimationFrame::visible()
    };

    match phase {
        AnimationPhase::In => {
            apply_in_animation(&mut frame, animation.in_type, progress, width, height)
        }
        AnimationPhase::Out => {
            apply_out_animation(&mut frame, animation.out_type, progress, width, height)
        }
    }

    frame
}

/// Evaluate only the opacity contribution of an overlay animation.
pub fn opacity_at(animation: &OverlayAnimation, time_ms: u64, start_ms: u64, end_ms: u64) -> f64 {
    animation_at(animation, time_ms, start_ms, end_ms, 0.0, 0.0).opacity
}

/// Apply the shared easing table to a normalized progress value.
pub fn eased_progress(easing: OverlayEasing, progress: f64) -> f64 {
    ease(easing, progress)
}

fn effective_durations(animation: &OverlayAnimation, clip_duration_ms: f64) -> (f64, f64) {
    let in_duration_ms = if animation.in_type == OverlayAnimationType::None {
        0.0
    } else {
        (animation.in_duration_ms as f64).min(clip_duration_ms)
    };
    let out_duration_ms = if animation.out_type == OverlayAnimationOutType::None {
        0.0
    } else {
        (animation.out_duration_ms as f64).min(clip_duration_ms)
    };
    let total_ms = in_duration_ms + out_duration_ms;

    if total_ms <= clip_duration_ms || total_ms == 0.0 {
        return (in_duration_ms, out_duration_ms);
    }

    let scale = clip_duration_ms / total_ms;
    (in_duration_ms * scale, out_duration_ms * scale)
}

fn apply_in_animation(
    frame: &mut OverlayAnimationFrame,
    animation: OverlayAnimationType,
    progress: f64,
    width: f64,
    height: f64,
) {
    match animation {
        OverlayAnimationType::None => {}
        OverlayAnimationType::Fade => frame.opacity = progress,
        OverlayAnimationType::ScaleUp => frame.scale = lerp(0.85, 1.0, progress),
        OverlayAnimationType::ScaleDown => frame.scale = lerp(1.15, 1.0, progress),
        OverlayAnimationType::SlideUp => frame.translate_y = (1.0 - progress) * height,
        OverlayAnimationType::SlideDown => frame.translate_y = -(1.0 - progress) * height,
        OverlayAnimationType::SlideLeft => frame.translate_x = (1.0 - progress) * width,
        OverlayAnimationType::SlideRight => frame.translate_x = -(1.0 - progress) * width,
        OverlayAnimationType::PopIn => {
            frame.scale = lerp(0.65, 1.0, progress);
            frame.opacity = (progress * 1.5).min(1.0);
        }
        OverlayAnimationType::Bounce => {
            let s = if progress < 0.65 {
                lerp(0.5, 1.08, progress / 0.65)
            } else {
                lerp(1.08, 1.0, (progress - 0.65) / 0.35)
            };
            frame.scale = s;
            frame.opacity = (progress * 1.5).min(1.0);
        }
        OverlayAnimationType::Draw => frame.draw_progress = progress,
        OverlayAnimationType::Typewriter => frame.text_progress = progress,
    }
}

fn apply_out_animation(
    frame: &mut OverlayAnimationFrame,
    animation: OverlayAnimationOutType,
    progress: f64,
    width: f64,
    height: f64,
) {
    match animation {
        OverlayAnimationOutType::None => {}
        OverlayAnimationOutType::Fade => frame.opacity = 1.0 - progress,
        OverlayAnimationOutType::ScaleUp => frame.scale = lerp(1.0, 1.15, progress),
        OverlayAnimationOutType::ScaleDown => frame.scale = lerp(1.0, 0.85, progress),
        OverlayAnimationOutType::SlideUp => frame.translate_y = -progress * height,
        OverlayAnimationOutType::SlideDown => frame.translate_y = progress * height,
        OverlayAnimationOutType::SlideLeft => frame.translate_x = -progress * width,
        OverlayAnimationOutType::SlideRight => frame.translate_x = progress * width,
    }
}

fn lerp(start: f64, end: f64, progress: f64) -> f64 {
    start + (end - start) * progress.clamp(0.0, 1.0)
}

fn ease(easing: OverlayEasing, progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    match easing {
        OverlayEasing::Linear => t,
        OverlayEasing::EaseIn => t * t,
        OverlayEasing::EaseOut => 1.0 - (1.0 - t) * (1.0 - t),
        OverlayEasing::EaseInOut => {
            if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            }
        }
        OverlayEasing::ExpoOut => {
            if t >= 1.0 {
                1.0
            } else {
                1.0 - 2.0_f64.powf(-10.0 * t)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_fade_timing_with_the_shared_easing_table() {
        let animation = OverlayAnimation {
            in_type: OverlayAnimationType::Fade,
            out_type: OverlayAnimationOutType::Fade,
            in_duration_ms: 100,
            out_duration_ms: 100,
            easing: OverlayEasing::Linear,
        };

        assert_eq!(opacity_at(&animation, 0, 0, 1_000), 0.0);
        assert_eq!(opacity_at(&animation, 50, 0, 1_000), 0.5);
        assert_eq!(opacity_at(&animation, 100, 0, 1_000), 1.0);
        assert_eq!(opacity_at(&animation, 950, 0, 1_000), 0.5);
        assert_eq!(opacity_at(&animation, 1_000, 0, 1_000), 0.0);
    }

    #[test]
    fn supports_slide_animation_progress() {
        let animation = OverlayAnimation {
            in_type: OverlayAnimationType::SlideUp,
            out_type: OverlayAnimationOutType::None,
            in_duration_ms: 100,
            out_duration_ms: 0,
            easing: OverlayEasing::Linear,
        };

        let frame = animation_at(&animation, 50, 0, 1_000, 200.0, 100.0);

        assert_eq!(frame.progress, 0.5);
        assert_eq!(frame.translate_x, 0.0);
        assert_eq!(frame.translate_y, 50.0);
        assert_eq!(frame.opacity, 1.0);
    }

    #[test]
    fn exposes_draw_and_typewriter_reveal_progress() {
        let draw = OverlayAnimation {
            in_type: OverlayAnimationType::Draw,
            out_type: OverlayAnimationOutType::None,
            in_duration_ms: 100,
            out_duration_ms: 0,
            easing: OverlayEasing::Linear,
        };
        let typewriter = OverlayAnimation {
            in_type: OverlayAnimationType::Typewriter,
            ..draw
        };

        let draw_frame = animation_at(&draw, 50, 0, 1_000, 0.0, 0.0);
        let text_frame = animation_at(&typewriter, 50, 0, 1_000, 0.0, 0.0);

        assert_eq!(draw_frame.draw_progress, 0.5);
        assert_eq!(draw_frame.text_progress, 1.0);
        assert_eq!(text_frame.draw_progress, 1.0);
        assert_eq!(text_frame.text_progress, 0.5);
    }

    #[test]
    fn evaluates_each_supported_easing_curve() {
        assert_eq!(eased_progress(OverlayEasing::Linear, 0.25), 0.25);
        assert_eq!(eased_progress(OverlayEasing::EaseIn, 0.25), 0.0625);
        assert_eq!(eased_progress(OverlayEasing::EaseOut, 0.25), 0.4375);
        assert_eq!(eased_progress(OverlayEasing::EaseInOut, 0.25), 0.125);
        assert!((eased_progress(OverlayEasing::ExpoOut, 0.5) - 0.96875).abs() < f64::EPSILON);
    }

    #[test]
    fn supports_horizontal_slide_and_pop_animations() {
        let slide_left = OverlayAnimation {
            in_type: OverlayAnimationType::SlideLeft,
            out_type: OverlayAnimationOutType::SlideRight,
            in_duration_ms: 100,
            out_duration_ms: 100,
            easing: OverlayEasing::Linear,
        };
        let in_frame = animation_at(&slide_left, 50, 0, 1_000, 200.0, 100.0);
        assert_eq!(in_frame.translate_x, 100.0);
        assert_eq!(in_frame.translate_y, 0.0);

        let out_frame = animation_at(&slide_left, 950, 0, 1_000, 200.0, 100.0);
        assert_eq!(out_frame.translate_x, 100.0);

        let pop_in = OverlayAnimation {
            in_type: OverlayAnimationType::PopIn,
            out_type: OverlayAnimationOutType::Fade,
            in_duration_ms: 100,
            out_duration_ms: 100,
            easing: OverlayEasing::Linear,
        };
        let pop_frame = animation_at(&pop_in, 50, 0, 1_000, 200.0, 100.0);
        assert!((pop_frame.scale - 0.825).abs() < 1e-4);

        let bounce = OverlayAnimation {
            in_type: OverlayAnimationType::Bounce,
            out_type: OverlayAnimationOutType::Fade,
            in_duration_ms: 100,
            out_duration_ms: 100,
            easing: OverlayEasing::Linear,
        };
        let bounce_frame = animation_at(&bounce, 50, 0, 1_000, 200.0, 100.0);
        assert!(bounce_frame.scale > 0.5 && bounce_frame.scale < 1.15);
    }
}
