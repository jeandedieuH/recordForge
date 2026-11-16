use serde::{Deserialize, Deserializer, Serialize};

use crate::{scene::TextDetails, OverlayError, OverlayTransform};

#[path = "title_glyphs.rs"]
mod glyphs;
#[path = "title_layout.rs"]
mod layout;

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),* $(,)? }) => {
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
        pub enum $name {
            #[default]
            $($variant),*
        }
        impl $name {
            fn from_str(value: &str) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant),)*
                    _ => None,
                }
            }
            fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)*
                }
            }
        }
        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = String::deserialize(d)?;
                Self::from_str(&value).ok_or_else(|| {
                    serde::de::Error::custom(format!("unknown {} value: {value}", stringify!($name)))
                })
            }
        }
    };
}

string_enum!(TitleTemplate {
    Hook => "hook",
    HookEmphasis => "hook-emphasis",
    Clean => "clean",
    Editorial => "editorial",
    Chapter => "chapter",
    LowerThirdBar => "lower-third-bar",
    LowerThirdGlass => "lower-third-glass",
    LowerThirdLine => "lower-third-line",
    SocialHandle => "social-handle",
    Cta => "cta",
    CtaFollow => "cta-follow",
    CtaLink => "cta-link",
    Step => "step",
    Checklist => "checklist",
    Shortcut => "shortcut",
    Terminal => "terminal",
    Callout => "callout",
    Quote => "quote",
    Stat => "stat",
    StatBeforeAfter => "stat-before-after",
    Countdown => "countdown",
    Location => "location",
    Banner => "banner",
    Highlight => "highlight",
    Kinetic => "kinetic",
    Agenda => "agenda",
    Outro => "outro",
    Source => "source",
});

// v1 template ids keep resolving so a v1 payload that slips past the TS
// migration (e.g. a render plan built from an old project) still renders.
impl TitleTemplate {
    fn from_any(value: &str) -> Option<Self> {
        Self::from_str(value).or(match value {
            "clean-text" => Some(Self::Clean),
            "emphasis" => Some(Self::HookEmphasis),
            "editorial-opener" => Some(Self::Editorial),
            "kinetic-hook" => Some(Self::Hook),
            "chapter-marker" => Some(Self::Chapter),
            "speaker-id" => Some(Self::LowerThirdBar),
            "source-credit" => Some(Self::Source),
            "step-guide" => Some(Self::Step),
            "shortcut" => Some(Self::Shortcut),
            "command-line" => Some(Self::Terminal),
            "note" => Some(Self::Callout),
            "pull-quote" => Some(Self::Quote),
            "metric" => Some(Self::Stat),
            "call-to-action" => Some(Self::Cta),
            _ => None,
        })
    }
}

string_enum!(TitleTextTransform {
    None => "none",
    Uppercase => "uppercase",
    Lowercase => "lowercase",
    Capitalize => "capitalize",
});

string_enum!(EmphasisStyle {
    Color => "color",
    Marker => "marker",
    Underline => "underline",
    Strike => "strike",
    Box => "box",
});

string_enum!(BackdropStyle {
    None => "none",
    Box => "box",
    Pill => "pill",
    Glass => "glass",
    Bar => "bar",
    Brackets => "brackets",
    Split => "split",
});

string_enum!(AccentStyle {
    None => "none",
    Bar => "bar",
    Dot => "dot",
    Number => "number",
});

string_enum!(AnimPreset {
    None => "none",
    Fade => "fade",
    Rise => "rise",
    Drop => "drop",
    SlideLeft => "slide-left",
    SlideRight => "slide-right",
    ScalePop => "scale-pop",
    Zoom => "zoom",
    BlurIn => "blur-in",
    Typewriter => "typewriter",
    MaskWipe => "mask-wipe",
    SplitReveal => "split-reveal",
    TrackingExpand => "tracking-expand",
    Flip => "flip",
    Bounce => "bounce",
    HighlightSweep => "highlight-sweep",
    UnderlineDraw => "underline-draw",
    Counter => "counter",
});

string_enum!(AnimUnit {
    Block => "block",
    Line => "line",
    Word => "word",
    Char => "char",
});

string_enum!(AnimEasing {
    Linear => "linear",
    CubicIn => "cubic-in",
    CubicOut => "cubic-out",
    CubicInOut => "cubic-in-out",
    ExpoIn => "expo-in",
    ExpoOut => "expo-out",
    ExpoInOut => "expo-in-out",
    BackOut => "back-out",
    ElasticOut => "elastic-out",
    Spring => "spring",
});

string_enum!(AnimDirection {
    Normal => "normal",
    Reverse => "reverse",
    CenterOut => "center-out",
    EdgesIn => "edges-in",
    Random => "random",
});

string_enum!(LoopPreset {
    None => "none",
    Pulse => "pulse",
    Shimmer => "shimmer",
    Float => "float",
});

string_enum!(PlacementAnchor {
    Tl => "tl",
    Tc => "tc",
    Tr => "tr",
    Cl => "cl",
    Cc => "cc",
    Cr => "cr",
    Bl => "bl",
    Bc => "bc",
    Br => "br",
});

string_enum!(FillKind {
    Solid => "solid",
    Gradient => "gradient",
});

string_enum!(NoteTone {
    Tip => "tip",
    Note => "note",
    Warning => "warning",
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleTypography {
    pub family: Option<String>,
    pub align: Option<String>,
    pub letter_spacing: f64,
    pub line_height: f64,
    pub text_transform: TitleTextTransform,
}
impl Default for TitleTypography {
    fn default() -> Self {
        Self {
            family: None,
            align: None,
            letter_spacing: 0.0,
            line_height: 1.15,
            text_transform: TitleTextTransform::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleElementStyle {
    pub family: Option<String>,
    pub size: Option<f64>,
    pub weight: Option<String>,
    pub letter_spacing: Option<f64>,
    pub line_height: Option<f64>,
    pub text_transform: Option<TitleTextTransform>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleElements {
    pub tag: Option<TitleElementStyle>,
    pub primary: Option<TitleElementStyle>,
    pub secondary: Option<TitleElementStyle>,
    pub metric: Option<TitleElementStyle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleGradientStop {
    pub offset: f64,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleFill {
    pub kind: FillKind,
    pub gradient_angle: f64,
    pub gradient_stops: Vec<TitleGradientStop>,
}
impl Default for TitleFill {
    fn default() -> Self {
        Self {
            kind: FillKind::Solid,
            gradient_angle: 135.0,
            gradient_stops: vec![
                TitleGradientStop {
                    offset: 0.0,
                    color: "#fafafa".into(),
                },
                TitleGradientStop {
                    offset: 1.0,
                    color: "#93c5fd".into(),
                },
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleStroke {
    pub color: String,
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleShadow {
    pub color: String,
    pub blur: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}
impl Default for TitleShadow {
    fn default() -> Self {
        Self {
            color: "rgba(0, 0, 0, 0.45)".into(),
            blur: 24.0,
            offset_x: 0.0,
            offset_y: 8.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleGlow {
    pub color: Option<String>,
    pub blur: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleEmphasis {
    pub text: String,
    pub style: EmphasisStyle,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleBackdrop {
    pub style: BackdropStyle,
    pub color: Option<String>,
    pub opacity: Option<f64>,
    pub radius: Option<f64>,
    pub padding_x: Option<f64>,
    pub padding_y: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleAccent {
    pub style: AccentStyle,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitlePlacement {
    pub anchor: PlacementAnchor,
    pub margin_x: f64,
    pub margin_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}
impl Default for TitlePlacement {
    fn default() -> Self {
        Self {
            anchor: PlacementAnchor::Cc,
            margin_x: 96.0,
            margin_y: 96.0,
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleAnimationSpec {
    pub preset: AnimPreset,
    pub unit: AnimUnit,
    pub duration_ms: f64,
    pub stagger_ms: f64,
    pub easing: AnimEasing,
    pub direction: AnimDirection,
}
impl Default for TitleAnimationSpec {
    fn default() -> Self {
        Self {
            preset: AnimPreset::Fade,
            unit: AnimUnit::Block,
            duration_ms: 450.0,
            stagger_ms: 60.0,
            easing: AnimEasing::ExpoOut,
            direction: AnimDirection::Normal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleEmphasisLoop {
    pub preset: LoopPreset,
    pub period_ms: f64,
    pub amplitude: f64,
}
impl Default for TitleEmphasisLoop {
    fn default() -> Self {
        Self {
            preset: LoopPreset::None,
            period_ms: 2400.0,
            amplitude: 0.5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleAnimation {
    #[serde(rename = "in")]
    pub in_spec: TitleAnimationSpec,
    #[serde(rename = "out")]
    pub out_spec: TitleAnimationSpec,
    pub emphasis: Option<TitleEmphasisLoop>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TitleMetric {
    pub from: f64,
    pub to: f64,
    pub decimals: u8,
    pub prefix: String,
    pub suffix: String,
}
impl Default for TitleMetric {
    fn default() -> Self {
        Self {
            from: 0.0,
            to: 98.0,
            decimals: 0,
            prefix: String::new(),
            suffix: "%".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleDesign {
    pub version: u8,
    pub template: TitleTemplate,
    pub tempo: f64,
    pub typography: TitleTypography,
    pub elements: TitleElements,
    pub fill: TitleFill,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<TitleStroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TitleShadow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glow: Option<TitleGlow>,
    pub emphasis: TitleEmphasis,
    pub backdrop: TitleBackdrop,
    pub accent: TitleAccent,
    pub placement: TitlePlacement,
    pub animation: TitleAnimation,
    pub metric: TitleMetric,
    pub note_tone: NoteTone,
}

// v1 payload shape, kept only for deserialization.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TitleDesignV1 {
    template: String,
    appearance: String,
    motion: String,
    tempo: f64,
    font_sizes: V1FontSizes,
    emphasis_text: String,
    note_tone: NoteTone,
    letter_spacing: f64,
    line_height: f64,
    metric: TitleMetric,
}
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct V1FontSizes {
    primary: Option<f64>,
    secondary: Option<f64>,
    tag: Option<f64>,
    metric: Option<f64>,
}
impl Default for TitleDesignV1 {
    fn default() -> Self {
        Self {
            template: "clean-text".into(),
            appearance: "dark".into(),
            motion: "designed".into(),
            tempo: 1.0,
            font_sizes: V1FontSizes::default(),
            emphasis_text: String::new(),
            note_tone: NoteTone::default(),
            letter_spacing: 0.0,
            line_height: 1.15,
            metric: TitleMetric::default(),
        }
    }
}

impl Default for TitleDesign {
    fn default() -> Self {
        Self {
            version: 2,
            template: TitleTemplate::Clean,
            tempo: 1.0,
            typography: TitleTypography::default(),
            elements: TitleElements::default(),
            fill: TitleFill::default(),
            stroke: None,
            shadow: None,
            glow: None,
            emphasis: TitleEmphasis::default(),
            backdrop: TitleBackdrop::default(),
            accent: TitleAccent::default(),
            placement: TitlePlacement::default(),
            animation: TitleAnimation::default(),
            metric: TitleMetric::default(),
            note_tone: NoteTone::default(),
        }
    }
}

impl<'de> Deserialize<'de> for TitleDesign {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let mut value = serde_json::Value::deserialize(d)?;
        if value.get("version").and_then(serde_json::Value::as_u64) == Some(1) {
            let v1: TitleDesignV1 =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            return Ok(migrate_v1(v1));
        }
        // `version` is a literal on the TS side; treat a missing one as 2.
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".into(), serde_json::Value::from(2));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct V2 {
            version: u8,
            template: String,
            tempo: f64,
            typography: TitleTypography,
            elements: TitleElements,
            fill: TitleFill,
            stroke: Option<TitleStroke>,
            shadow: Option<TitleShadow>,
            glow: Option<TitleGlow>,
            emphasis: TitleEmphasis,
            backdrop: TitleBackdrop,
            accent: TitleAccent,
            placement: TitlePlacement,
            animation: TitleAnimation,
            metric: TitleMetric,
            note_tone: NoteTone,
        }
        impl Default for V2 {
            fn default() -> Self {
                let d = TitleDesign::default();
                Self {
                    version: 2,
                    template: d.template.as_str().into(),
                    tempo: d.tempo,
                    typography: d.typography,
                    elements: d.elements,
                    fill: d.fill,
                    stroke: d.stroke,
                    shadow: d.shadow,
                    glow: d.glow,
                    emphasis: d.emphasis,
                    backdrop: d.backdrop,
                    accent: d.accent,
                    placement: d.placement,
                    animation: d.animation,
                    metric: d.metric,
                    note_tone: d.note_tone,
                }
            }
        }
        let v2: V2 = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        if v2.version != 2 {
            return Err(serde::de::Error::custom("unsupported titleDesign version"));
        }
        let template = TitleTemplate::from_any(&v2.template)
            .ok_or_else(|| serde::de::Error::custom("unknown title template"))?;
        Ok(TitleDesign {
            version: 2,
            template,
            tempo: v2.tempo,
            typography: v2.typography,
            elements: v2.elements,
            fill: v2.fill,
            stroke: v2.stroke,
            shadow: v2.shadow,
            glow: v2.glow,
            emphasis: v2.emphasis,
            backdrop: v2.backdrop,
            accent: v2.accent,
            placement: v2.placement,
            animation: v2.animation,
            metric: v2.metric,
            note_tone: v2.note_tone,
        })
    }
}

// Mirror of `migrateTitleDesignV1` in contracts/title-design.ts. Render plans
// built outside project load (harness fixtures, old exports) can still carry a
// v1 design, so the engine migrates standalone with the same defaults.
fn migrate_v1(v1: TitleDesignV1) -> TitleDesign {
    let template = TitleTemplate::from_any(&v1.template).unwrap_or(TitleTemplate::Clean);
    let mut elements = TitleElements::default();
    let size = |v: Option<f64>| {
        v.map(|s| TitleElementStyle {
            size: Some(s),
            ..Default::default()
        })
    };
    elements.primary = size(v1.font_sizes.primary);
    elements.secondary = size(v1.font_sizes.secondary);
    elements.tag = size(v1.font_sizes.tag);
    elements.metric = size(v1.font_sizes.metric);

    let spec = |preset: AnimPreset,
                unit: AnimUnit,
                duration_ms: f64,
                stagger_ms: f64,
                easing: AnimEasing| TitleAnimationSpec {
        preset,
        unit,
        duration_ms,
        stagger_ms,
        easing,
        direction: AnimDirection::Normal,
    };
    let (in_spec, out_spec) = match v1.motion.as_str() {
        "none" => (
            spec(
                AnimPreset::None,
                AnimUnit::Block,
                0.0,
                0.0,
                AnimEasing::Linear,
            ),
            spec(
                AnimPreset::None,
                AnimUnit::Block,
                0.0,
                0.0,
                AnimEasing::Linear,
            ),
        ),
        "subtle" => (
            spec(
                AnimPreset::Rise,
                AnimUnit::Block,
                420.0,
                0.0,
                AnimEasing::ExpoOut,
            ),
            spec(
                AnimPreset::Fade,
                AnimUnit::Block,
                260.0,
                0.0,
                AnimEasing::ExpoIn,
            ),
        ),
        _ => (
            designed_in(template),
            spec(
                AnimPreset::Fade,
                AnimUnit::Block,
                260.0,
                0.0,
                AnimEasing::ExpoIn,
            ),
        ),
    };

    TitleDesign {
        version: 2,
        template,
        tempo: v1.tempo,
        typography: TitleTypography {
            letter_spacing: v1.letter_spacing,
            line_height: v1.line_height,
            ..Default::default()
        },
        elements,
        fill: TitleFill::default(),
        stroke: None,
        shadow: None,
        glow: None,
        emphasis: TitleEmphasis {
            text: v1.emphasis_text,
            style: EmphasisStyle::Marker,
            color: None,
        },
        backdrop: TitleBackdrop {
            style: if v1.appearance == "transparent" {
                BackdropStyle::None
            } else {
                BackdropStyle::Box
            },
            ..Default::default()
        },
        accent: TitleAccent::default(),
        placement: TitlePlacement::default(),
        animation: TitleAnimation {
            in_spec,
            out_spec,
            emphasis: None,
        },
        metric: v1.metric,
        note_tone: v1.note_tone,
    }
}

fn designed_in(template: TitleTemplate) -> TitleAnimationSpec {
    let s = |preset: AnimPreset,
             unit: AnimUnit,
             duration_ms: f64,
             stagger_ms: f64,
             easing: AnimEasing| TitleAnimationSpec {
        preset,
        unit,
        duration_ms,
        stagger_ms,
        easing,
        direction: AnimDirection::Normal,
    };
    match template {
        TitleTemplate::Kinetic | TitleTemplate::Hook | TitleTemplate::HookEmphasis => s(
            AnimPreset::ScalePop,
            AnimUnit::Word,
            480.0,
            70.0,
            AnimEasing::BackOut,
        ),
        TitleTemplate::Terminal => s(
            AnimPreset::Typewriter,
            AnimUnit::Char,
            700.0,
            24.0,
            AnimEasing::Linear,
        ),
        TitleTemplate::Highlight => s(
            AnimPreset::HighlightSweep,
            AnimUnit::Line,
            520.0,
            120.0,
            AnimEasing::ExpoOut,
        ),
        TitleTemplate::Countdown | TitleTemplate::Stat | TitleTemplate::StatBeforeAfter => s(
            AnimPreset::Counter,
            AnimUnit::Block,
            900.0,
            0.0,
            AnimEasing::ExpoOut,
        ),
        TitleTemplate::LowerThirdBar
        | TitleTemplate::LowerThirdGlass
        | TitleTemplate::LowerThirdLine => s(
            AnimPreset::SlideLeft,
            AnimUnit::Block,
            380.0,
            80.0,
            AnimEasing::ExpoOut,
        ),
        TitleTemplate::Checklist | TitleTemplate::Agenda => s(
            AnimPreset::Rise,
            AnimUnit::Line,
            400.0,
            110.0,
            AnimEasing::ExpoOut,
        ),
        TitleTemplate::Banner => s(
            AnimPreset::MaskWipe,
            AnimUnit::Block,
            500.0,
            0.0,
            AnimEasing::ExpoOut,
        ),
        _ => s(
            AnimPreset::Rise,
            AnimUnit::Line,
            460.0,
            90.0,
            AnimEasing::ExpoOut,
        ),
    }
}

impl TitleDesign {
    pub(crate) fn validate(&self) -> Result<(), OverlayError> {
        let spec_ok = |s: &TitleAnimationSpec| {
            s.duration_ms.is_finite()
                && (0.0..=10_000.0).contains(&s.duration_ms)
                && s.stagger_ms.is_finite()
                && (0.0..=2_000.0).contains(&s.stagger_ms)
        };
        let style_ok = |s: &TitleElementStyle| {
            s.size
                .is_none_or(|v| v.is_finite() && (4.0..=1200.0).contains(&v))
        };
        if self.version != 2
            || !(0.5..=2.0).contains(&self.tempo)
            || !self.typography.letter_spacing.is_finite()
            || !(-0.05..=0.5).contains(&self.typography.letter_spacing)
            || !(0.8..=2.2).contains(&self.typography.line_height)
            || !spec_ok(&self.animation.in_spec)
            || !spec_ok(&self.animation.out_spec)
            || [
                &self.elements.tag,
                &self.elements.primary,
                &self.elements.secondary,
                &self.elements.metric,
            ]
            .into_iter()
            .flatten()
            .any(|s| !style_ok(s))
            || self.metric.decimals > 3
            || self.emphasis.text.chars().count() > 500
        {
            return Err(OverlayError::InvalidPlan("invalid title design".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSceneGradient {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub stops: Vec<TitleGradientStop>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSceneStroke {
    pub color: String,
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSceneElement {
    pub path: String,
    pub fill: String,
    pub opacity: f64,
    pub translate_x: f64,
    pub translate_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<TitleClip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<TitleSceneGradient>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<TitleSceneStroke>,
}
impl TitleSceneElement {
    fn new(path: String, fill: &str) -> Self {
        Self {
            path,
            fill: fill.into(),
            opacity: 1.0,
            translate_x: 0.0,
            translate_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            clip: None,
            gradient: None,
            stroke: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleScene {
    pub width: f64,
    pub height: f64,
    pub elements: Vec<TitleSceneElement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Backdrop,
    Decoration,
    Tag,
    Primary,
    Secondary,
}

#[derive(Debug, Clone)]
struct Part {
    element: TitleSceneElement,
    role: Role,
    // Unit indices within this part's role: line/word/char counters used by the
    // animation specs to stagger. Non-text parts keep 0/1 so they act as a
    // single block.
    line_idx: u32,
    word_idx: u32,
    char_idx: u32,
    line_count: u32,
    word_count: u32,
    char_count: u32,
    // Center in scene space for scale/flip presets.
    anchor: (f64, f64),
    // Extra outward offset collapsed by `tracking-expand`.
    tracking: f64,
    // Clip rect used by mask/sweep presets; defaults to the element's own clip.
    sweep: Option<TitleClip>,
    // Character-reveal threshold (0..1) for the typewriter preset.
    typing: Option<f64>,
    emphasis: bool,
    // Shimmer sweep: element is a gradient bar whose translate_x is animated
    // between these two scene x positions once per period.
    shimmer: Option<(f64, f64)>,
}

#[derive(Debug, Clone)]
struct MetricLayout {
    glyphs: Vec<(char, String)>,
    cells: usize,
    x: f64,
    y: f64,
    size: f64,
    advance: f64,
    fill: String,
    metric: TitleMetric,
    // `step` renders integer steps (countdown) instead of a smooth count.
    step: bool,
    anchor: (f64, f64),
    clip: TitleClip,
}

#[derive(Debug, Clone)]
pub(crate) struct TitleLayout {
    width: f64,
    height: f64,
    parts: Vec<Part>,
    metrics: Vec<MetricLayout>,
    design: TitleDesign,
}

/// Compile and evaluate a designed title for a point on the clip timeline.
/// Returns `None` when the clip has no title design, letting the legacy text renderer take over.
pub fn compile_and_evaluate(
    details: &TextDetails,
    transform: &OverlayTransform,
    elapsed: u64,
    duration: u64,
) -> Result<Option<TitleScene>, OverlayError> {
    let Some(design) = details.title_design.as_ref() else {
        return Ok(None);
    };
    design.validate()?;
    if details.primary_text.len()
        + details.secondary_text.as_ref().map_or(0, String::len)
        + details.tag_text.as_ref().map_or(0, String::len)
        > 32768
    {
        return Err(OverlayError::InvalidPlan(
            "title text exceeds layout budget".into(),
        ));
    }
    Ok(Some(
        layout::compile(details, transform, design).evaluate(elapsed, duration),
    ))
}

/// Wrap text with the same bundled font metrics used to rasterize SVG text in
/// export. Keeps preview line breaks (browser measureText over the same Inter /
/// Source Serif / JetBrains Mono files) and export nearly identical.
#[cfg(feature = "native-render")]
pub(crate) fn wrap_text_for_render(
    family: &str,
    weight: &str,
    text: &str,
    width: f64,
    size: f64,
) -> Vec<String> {
    let face = glyphs::face(family, weight);
    glyphs::wrap(&face, text, width, size, 0.0)
}

fn ease(t: f64, easing: AnimEasing) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match easing {
        AnimEasing::Linear => t,
        AnimEasing::CubicIn => t * t * t,
        AnimEasing::CubicOut => 1.0 - (1.0 - t).powi(3),
        AnimEasing::CubicInOut => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        AnimEasing::ExpoIn => {
            if t <= 0.0 {
                0.0
            } else {
                2.0_f64.powf(10.0 * t - 10.0)
            }
        }
        AnimEasing::ExpoOut => {
            if t >= 1.0 {
                1.0
            } else {
                1.0 - 2.0_f64.powf(-10.0 * t)
            }
        }
        AnimEasing::ExpoInOut => {
            if t <= 0.0 {
                0.0
            } else if t >= 1.0 {
                1.0
            } else if t < 0.5 {
                2.0_f64.powf(20.0 * t - 10.0) / 2.0
            } else {
                (2.0 - 2.0_f64.powf(-20.0 * t + 10.0)) / 2.0
            }
        }
        AnimEasing::BackOut => {
            let c1 = 1.70158;
            let c3 = c1 + 1.0;
            1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
        }
        AnimEasing::ElasticOut => {
            if t <= 0.0 {
                0.0
            } else if t >= 1.0 {
                1.0
            } else {
                2.0_f64.powf(-10.0 * t)
                    * ((t * 10.0 - 0.75) * (2.0 * std::f64::consts::PI / 3.0)).sin()
                    + 1.0
            }
        }
        AnimEasing::Spring => {
            // Damped spring approximation (no overshoot beyond ~8%).
            if t >= 1.0 {
                1.0
            } else {
                1.0 - (-6.0 * t).exp() * (9.0 * t).cos()
            }
        }
    }
}

impl TitleLayout {
    fn unit_cursor(&self, part: &Part, unit: AnimUnit) -> (u32, u32) {
        match unit {
            AnimUnit::Block => (
                match part.role {
                    Role::Backdrop => 0,
                    Role::Decoration => 1,
                    Role::Tag => 2,
                    Role::Primary => 3,
                    Role::Secondary => 4,
                },
                5,
            ),
            AnimUnit::Line => (part.line_idx, part.line_count),
            AnimUnit::Word => (part.word_idx, part.word_count),
            AnimUnit::Char => (part.char_idx, part.char_count),
        }
    }

    fn stagger_order(idx: u32, count: u32, direction: AnimDirection) -> f64 {
        if count <= 1 {
            return 0.0;
        }
        let i = idx.min(count - 1) as f64;
        let n = (count - 1) as f64;
        let order = match direction {
            AnimDirection::Normal => i,
            AnimDirection::Reverse => n - i,
            AnimDirection::CenterOut => (i - n / 2.0).abs() * 2.0,
            AnimDirection::EdgesIn => (n / 2.0 - (i - n / 2.0).abs()) * 2.0,
            // Deterministic hash keeps preview and export identical.
            AnimDirection::Random => {
                let h = (idx.wrapping_mul(2_654_435_761) ^ 0x9e37_79b9) as u64;
                (h % 1000) as f64 / 1000.0 * n
            }
        };
        (order / n).clamp(0.0, 1.0)
    }

    fn unit_progress(&self, part: &Part, spec: &TitleAnimationSpec, elapsed: f64) -> (f64, f64) {
        if spec.preset == AnimPreset::None || spec.duration_ms <= 0.0 {
            return (1.0, 1.0);
        }
        let (idx, count) = self.unit_cursor(part, spec.unit);
        let order = Self::stagger_order(idx, count, spec.direction);
        let delay = order * spec.stagger_ms.min(spec.duration_ms);
        let duration = (spec.duration_ms / self.design.tempo).max(1.0);
        let delay = delay / self.design.tempo;
        let raw = ((elapsed - delay) / duration).clamp(0.0, 1.0);
        (ease(raw, spec.easing), raw)
    }

    fn out_progress(
        &self,
        part: &Part,
        spec: &TitleAnimationSpec,
        elapsed: f64,
        duration: f64,
    ) -> f64 {
        if spec.preset == AnimPreset::None || spec.duration_ms <= 0.0 {
            return 0.0;
        }
        let total = (spec.duration_ms + spec.stagger_ms) / self.design.tempo;
        let out_start = (duration - total).max(duration * 0.4);
        let (idx, count) = self.unit_cursor(part, spec.unit);
        let order = Self::stagger_order(idx, count, spec.direction);
        let delay = order * spec.stagger_ms / self.design.tempo;
        let d = (spec.duration_ms / self.design.tempo).max(1.0);
        let raw = ((elapsed - out_start - delay) / d).clamp(0.0, 1.0);
        ease(raw, spec.easing)
    }

    /// Apply the entrance preset for eased progress `p` (0 = fully hidden).
    fn apply_in(
        &self,
        e: &mut TitleSceneElement,
        part: &Part,
        p: f64,
        raw: f64,
        extra: &mut Vec<TitleSceneElement>,
    ) {
        let spec = &self.design.animation.in_spec;
        let dist = self.height.min(260.0) * 0.22;
        let scale_about = |e: &mut TitleSceneElement, s: f64, anchor: (f64, f64)| {
            // Elements are drawn translate→scale→path; scaling about an anchor
            // means compensating the translate by the anchor's shift.
            e.scale_x *= s;
            e.scale_y *= s;
            e.translate_x += anchor.0 * (1.0 - s);
            e.translate_y += anchor.1 * (1.0 - s);
        };
        match spec.preset {
            AnimPreset::None => {}
            AnimPreset::Fade | AnimPreset::Counter => e.opacity *= p,
            AnimPreset::Rise | AnimPreset::SplitReveal => {
                e.translate_y += (1.0 - p) * dist;
                e.opacity *= (p * 1.4).min(1.0);
                if spec.preset == AnimPreset::SplitReveal {
                    if let Some(rect) = part.sweep.or(e.clip) {
                        e.clip = Some(rect);
                    }
                }
            }
            AnimPreset::Drop => {
                e.translate_y -= (1.0 - p) * dist;
                e.opacity *= (p * 1.4).min(1.0);
            }
            AnimPreset::SlideLeft => {
                e.translate_x -= (1.0 - p) * dist * 1.4;
                e.opacity *= (p * 1.4).min(1.0);
            }
            AnimPreset::SlideRight => {
                e.translate_x += (1.0 - p) * dist * 1.4;
                e.opacity *= (p * 1.4).min(1.0);
            }
            AnimPreset::ScalePop | AnimPreset::Bounce => {
                scale_about(e, 0.55 + 0.45 * p, part.anchor);
                e.opacity *= (p * 1.6).min(1.0);
            }
            AnimPreset::Zoom => {
                scale_about(e, 1.28 - 0.28 * p, part.anchor);
                e.opacity *= p;
            }
            AnimPreset::BlurIn => {
                // Canvas 2D in WKWebView lacks ctx.filter, so blur is expanded
                // into low-alpha tap copies in the engine; both renderers draw
                // the same elements.
                let blur = (1.0 - p) * self.height.min(160.0) * 0.08;
                e.opacity *= p;
                if blur > 0.4 {
                    emit_blur_taps(e, blur, extra);
                }
            }
            AnimPreset::Typewriter => {
                let threshold = part.typing.unwrap_or(0.0);
                e.opacity *= if raw >= threshold { 1.0 } else { 0.0 };
            }
            AnimPreset::MaskWipe => {
                let mut rect = part.sweep.or(e.clip).unwrap_or(TitleClip {
                    x: 0.0,
                    y: 0.0,
                    width: self.width,
                    height: self.height,
                });
                rect.width *= p.max(0.001);
                e.clip = Some(rect);
                e.opacity *= (p * 2.5).min(1.0);
            }
            AnimPreset::TrackingExpand => {
                e.translate_x += (1.0 - p) * part.tracking;
                e.opacity *= (p * 1.5).min(1.0);
            }
            AnimPreset::Flip => {
                e.scale_y *= p.max(0.02);
                e.translate_y += part.anchor.1 * (1.0 - p.max(0.02));
                e.opacity *= (p * 1.6).min(1.0);
            }
            AnimPreset::HighlightSweep | AnimPreset::UnderlineDraw => {
                if part.emphasis {
                    let mut rect = part.sweep.or(e.clip).unwrap_or(TitleClip {
                        x: e.translate_x,
                        y: e.translate_y - self.height * 0.1,
                        width: self.width,
                        height: self.height * 0.2,
                    });
                    rect.width *= p.max(0.001);
                    e.clip = Some(rect);
                } else {
                    e.opacity *= p;
                }
            }
        }
    }

    /// Apply the exit preset for eased progress `q` (0 = still fully shown).
    fn apply_out(&self, e: &mut TitleSceneElement, part: &Part, q: f64) {
        if q <= 0.0 {
            return;
        }
        let spec = &self.design.animation.out_spec;
        let dist = self.height.min(220.0) * 0.16;
        match spec.preset {
            AnimPreset::None => {}
            AnimPreset::Rise => e.translate_y -= q * dist,
            AnimPreset::Drop => e.translate_y += q * dist,
            AnimPreset::SlideLeft => e.translate_x -= q * dist * 1.6,
            AnimPreset::SlideRight => e.translate_x += q * dist * 1.6,
            AnimPreset::ScalePop | AnimPreset::Bounce | AnimPreset::Zoom => {
                let s = 1.0 - q * 0.4;
                e.scale_x *= s;
                e.scale_y *= s;
                e.translate_x += part.anchor.0 * (1.0 - s);
                e.translate_y += part.anchor.1 * (1.0 - s);
                e.opacity *= 1.0 - q;
                return;
            }
            AnimPreset::Flip => {
                e.scale_y *= (1.0 - q).max(0.02);
                e.translate_y += part.anchor.1 * q;
                e.opacity *= 1.0 - q;
                return;
            }
            _ => {}
        }
        e.opacity *= 1.0 - q;
    }

    fn apply_emphasis_loop(&self, e: &mut TitleSceneElement, part: &Part, elapsed: f64) {
        let Some(loop_spec) = &self.design.animation.emphasis else {
            return;
        };
        if loop_spec.preset == LoopPreset::None || loop_spec.period_ms <= 0.0 {
            return;
        }
        // With no emphasis-marked parts, loops target primary text.
        if !(part.emphasis || (part.role == Role::Primary && !self.layout_has_emphasis())) {
            return;
        }
        let phase =
            (elapsed / loop_spec.period_ms * std::f64::consts::TAU) + part.char_idx as f64 * 0.6;
        match loop_spec.preset {
            LoopPreset::Pulse => {
                let s = 1.0 + loop_spec.amplitude * 0.06 * phase.sin();
                e.scale_x *= s;
                e.scale_y *= s;
                e.translate_x += part.anchor.0 * (1.0 - s);
                e.translate_y += part.anchor.1 * (1.0 - s);
            }
            LoopPreset::Float => {
                e.translate_y += loop_spec.amplitude * 7.0 * phase.sin();
            }
            LoopPreset::Shimmer => {
                if let Some((from, to)) = part.shimmer {
                    let t = (elapsed / loop_spec.period_ms) % 1.0;
                    e.translate_x = from + (to - from) * t;
                }
            }
            LoopPreset::None => {}
        }
    }

    fn layout_has_emphasis(&self) -> bool {
        self.parts.iter().any(|p| p.emphasis)
    }

    pub(crate) fn evaluate(&self, elapsed: u64, duration: u64) -> TitleScene {
        let elapsed = elapsed as f64;
        let duration = duration.max(1) as f64;
        let in_spec = self.design.animation.in_spec.clone();
        let out_spec = self.design.animation.out_spec.clone();
        let mut elements = Vec::with_capacity(self.parts.len() + 48);
        for part in &self.parts {
            let mut e = part.element.clone();
            if e.path.is_empty() {
                continue;
            }
            if let Some((from, _)) = part.shimmer {
                e.translate_x = from;
            }
            let (p, raw) = self.unit_progress(part, &in_spec, elapsed);
            let q = self.out_progress(part, &out_spec, elapsed, duration);
            self.apply_in(&mut e, part, p, raw, &mut elements);
            self.apply_out(&mut e, part, q);
            self.apply_emphasis_loop(&mut e, part, elapsed);
            elements.push(e);
        }
        for metric in &self.metrics {
            // Only numeric formatting changes per frame; all digits were shaped
            // at scene creation.
            let (p, _raw) = {
                let probe = Part {
                    element: TitleSceneElement::new(String::new(), ""),
                    role: Role::Primary,
                    line_idx: 0,
                    word_idx: 0,
                    char_idx: 0,
                    line_count: 1,
                    word_count: 1,
                    char_count: 1,
                    anchor: metric.anchor,
                    tracking: 0.0,
                    sweep: None,
                    typing: None,
                    emphasis: false,
                    shimmer: None,
                };
                self.unit_progress(&probe, &in_spec, elapsed)
            };
            let q = self.out_progress(
                &Part {
                    element: TitleSceneElement::new(String::new(), ""),
                    role: Role::Primary,
                    line_idx: 0,
                    word_idx: 0,
                    char_idx: 0,
                    line_count: 1,
                    word_count: 1,
                    char_count: 1,
                    anchor: metric.anchor,
                    tracking: 0.0,
                    sweep: None,
                    typing: None,
                    emphasis: false,
                    shimmer: None,
                },
                &out_spec,
                elapsed,
                duration,
            );
            let raw = metric.metric.from + (metric.metric.to - metric.metric.from) * p;
            let mut value = raw;
            if metric.step {
                value = value.ceil().min(metric.metric.from.max(metric.metric.to));
            }
            let text = format!("{:.*}", metric.metric.decimals as usize, value);
            let offset = metric.cells.saturating_sub(text.chars().count()) as f64 * metric.advance;
            let opacity = (1.0 - q).clamp(0.0, 1.0);
            // Countdown steps pop as each new integer lands: the fractional
            // part of the continuous value (not the stepped one) marks the
            // transition, and the pulse is released once counting completes.
            let step_pulse = if metric.step && p < 1.0 {
                let frac = (metric.metric.from - raw).abs() % 1.0;
                1.0 + 0.12 * (1.0 - frac.min(1.0))
            } else {
                1.0
            };
            for (i, ch) in text.chars().enumerate() {
                if let Some((_, path)) = metric.glyphs.iter().find(|(c, _)| *c == ch) {
                    let mut e = TitleSceneElement {
                        path: path.clone(),
                        fill: metric.fill.clone(),
                        opacity,
                        translate_x: metric.x + offset + i as f64 * metric.advance,
                        translate_y: metric.y,
                        scale_x: metric.size * step_pulse,
                        scale_y: metric.size * step_pulse,
                        clip: Some(metric.clip),
                        gradient: None,
                        stroke: None,
                    };
                    if step_pulse != 1.0 {
                        e.translate_x += metric.anchor.0 * (1.0 - step_pulse);
                        e.translate_y += metric.anchor.1 * (1.0 - step_pulse);
                    }
                    elements.push(e);
                }
            }
        }
        TitleScene {
            width: self.width,
            height: self.height,
            elements,
        }
    }
}

// Approximate a gaussian blur with tap copies; used by the blur-in preset so
// WKWebView previews (no ctx.filter) and the SVG rasterizer draw the same
// softened glyph.
fn emit_blur_taps(e: &TitleSceneElement, radius: f64, out: &mut Vec<TitleSceneElement>) {
    const TAPS: usize = 7;
    for i in 0..TAPS {
        let angle = i as f64 / TAPS as f64 * std::f64::consts::TAU;
        let mut tap = e.clone();
        tap.translate_x += angle.cos() * radius;
        tap.translate_y += angle.sin() * radius;
        tap.opacity *= 0.16;
        tap.clip = e.clip;
        out.push(tap);
    }
}
