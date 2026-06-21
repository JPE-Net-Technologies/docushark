//! LLM-optimized DSL ↔ DocuShark shape JSON.
//!
//! The MCP tool surface accepts a small compact DSL so an LLM can think in
//! `{kind, x, y, w?, h?, text?, style?}` instead of the full `BaseShape`
//! structure. This module is the single source of truth for that mapping.
//!
//! Defaults mirror `src/shapes/Shape.ts` (DEFAULT_SHAPE_STYLE,
//! DEFAULT_RECTANGLE, DEFAULT_ELLIPSE, DEFAULT_TEXT). Foundation scope
//! covers rectangle, ellipse, and text only — connector, line, group are
//! intentionally deferred per the foundation plan.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Compact shape kind accepted by the MCP DSL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DslKind {
    Rectangle,
    Ellipse,
    Text,
    Connector,
}

/// Optional style block on a DSL shape. Any field set to the string `"AUTO"`
/// (case-insensitive) is forwarded as the literal sentinel `"auto"` so the
/// frontend's contrast-aware colour resolver picks an appropriate value at
/// render time (see memory: Color Palette UX Phase 19).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DslStyle {
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f64>,
    pub label_color: Option<String>,
    /// Keys serde didn't recognize. Captured (not silently dropped) so the
    /// write tools can report them back to the agent — e.g. a `fillColor`
    /// typo for `fill` (JP-312 "talk back" residual). Never written to the
    /// shape JSON.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, Value>,
}

/// Compact shape definition accepted by `docushark.add_shape`.
///
/// Connector shapes ignore `x`/`y`/`w`/`h` and instead use the connect
/// helper in `tools.rs`, which fills them in from the start shape's
/// position; passing them is harmless but does not override anchoring.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DslShape {
    pub kind: DslKind,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub text: Option<String>,
    pub style: Option<DslStyle>,
    /// Caller-provided id. If absent, the tool generates one.
    pub id: Option<String>,
    /// Icon to render on the shape (rectangle/ellipse). An icon-library id from
    /// `docushark.list_icons`, e.g. "builtin:aws-amazon-s3". Ignored if empty.
    pub icon_id: Option<String>,
    /// How the icon is shown: "inside" (default) | "badge" | "icon-only".
    pub icon_display_mode: Option<String>,
    /// Icon size in px (default 24). Mostly relevant for inside/badge modes;
    /// icon-only fills the shape bounds.
    pub icon_size: Option<f64>,
    /// Connector-only: id of the shape at the start of the connector.
    pub start_shape_id: Option<String>,
    /// Connector-only: id of the shape at the end of the connector.
    pub end_shape_id: Option<String>,
    /// Connector-only: anchor on the start shape (default "center").
    pub start_anchor: Option<String>,
    /// Connector-only: anchor on the end shape (default "center").
    pub end_anchor: Option<String>,
    /// Connector-only: arrowhead style at the start endpoint.
    /// One of "none" | "triangle" | "open" | "diamond". Defaults to "none".
    pub start_arrow_style: Option<String>,
    /// Connector-only: arrowhead style at the end endpoint.
    /// One of "none" | "triangle" | "open" | "diamond". Defaults to "triangle".
    pub end_arrow_style: Option<String>,
    /// Connector-only: path routing mode. One of "straight" | "orthogonal" |
    /// "curved". Omitted = the editor's default (straight). Invalid values
    /// are dropped rather than guessed.
    pub routing_mode: Option<String>,
    /// Connector-only: interior waypoints of a routed path, start to end
    /// (endpoints excluded — they come from the anchors). Only meaningful
    /// with a non-straight `routing_mode`.
    pub waypoints: Option<Vec<DslPoint>>,
    /// Connector-only: label position along the path as an arc-length
    /// fraction (clamped to 0..=1; the editor defaults to 0.5).
    pub label_position: Option<f64>,
    /// Connector-only: end-point seed. Defaults to `x`/`y`; the renderer
    /// recalculates both endpoints from the connected shapes each frame, so
    /// this only shapes the first paint of a cold document.
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    /// Keys serde didn't recognize, captured for the write tools to report
    /// instead of silently dropping (JP-312 "talk back"). Never written out.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, Value>,
}

/// A waypoint on a routed connector path.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct DslPoint {
    pub x: f64,
    pub y: f64,
}

/// Validate a DSL routing-mode string. Keep the accepted set in lockstep
/// with `RoutingMode` in `src/shapes/Shape.ts`.
fn normalize_routing_mode(s: &str) -> Option<&'static str> {
    match s {
        "straight" => Some("straight"),
        "orthogonal" => Some("orthogonal"),
        "curved" => Some("curved"),
        _ => None,
    }
}

/// Validate a DSL arrow-style string against the four accepted values.
/// Returns `None` for unknown / empty input so the caller can fall back
/// to the field's default. Keep the accepted set in lockstep with
/// `ArrowStyle` in `src/shapes/Shape.ts`.
fn normalize_arrow_style(s: &str) -> Option<&'static str> {
    match s {
        "none" => Some("none"),
        "triangle" => Some("triangle"),
        "open" => Some("open"),
        "diamond" => Some("diamond"),
        _ => None,
    }
}

/// Validate a DSL icon display-mode string. Keep in lockstep with
/// `IconDisplayMode` in `src/shapes/Shape.ts`. Unknown values are dropped so a
/// bad mode doesn't override the renderer default ("inside").
fn normalize_icon_display_mode(s: &str) -> Option<&'static str> {
    match s {
        "inside" => Some("inside"),
        "badge" => Some("badge"),
        "icon-only" => Some("icon-only"),
        _ => None,
    }
}

/// Insert the icon fields onto a shape object, when an icon is requested. A
/// non-empty `icon_id` is required (display mode / size alone do nothing). An
/// unknown display mode is ignored (renderer default applies). Shared by the
/// rectangle/ellipse builders.
fn apply_icon_fields(
    o: &mut serde_json::Map<String, Value>,
    icon_id: Option<&String>,
    display_mode: Option<&String>,
    icon_size: Option<f64>,
) {
    let Some(icon_id) = icon_id.filter(|s| !s.is_empty()) else {
        return;
    };
    o.insert("iconId".into(), json!(icon_id));
    if let Some(mode) = display_mode.map(String::as_str).and_then(normalize_icon_display_mode) {
        o.insert("iconDisplayMode".into(), json!(mode));
    }
    if let Some(size) = icon_size {
        o.insert("iconSize".into(), json!(size));
    }
}

/// Convert a DSL shape into the on-disk shape JSON used by DocuShark.
/// `id` must be unique within the page; callers are responsible for that.
pub fn dsl_to_shape_json(dsl: &DslShape, id: &str) -> Value {
    match dsl.kind {
        DslKind::Rectangle => rectangle(dsl, id),
        DslKind::Ellipse => ellipse(dsl, id),
        DslKind::Text => text(dsl, id),
        DslKind::Connector => connector(dsl, id),
    }
}

/// Apply a partial DSL patch onto an existing shape JSON value, mutating
/// in place. Only fields the foundation adapter knows about are updated;
/// anything else (`rotation`, `cornerRadius`, ERD bits, etc.) is left
/// alone so a partial update doesn't accidentally erase advanced state
/// the renderer set.
///
/// Returns the set of field paths that were actually changed so callers
/// can surface a useful summary.
pub fn apply_dsl_patch(shape: &mut Value, patch: &DslPatch) -> Vec<String> {
    let mut changed = Vec::new();
    let obj = match shape.as_object_mut() {
        Some(o) => o,
        None => return changed,
    };

    if let Some(x) = patch.x {
        obj.insert("x".into(), json!(x));
        changed.push("x".into());
    }
    if let Some(y) = patch.y {
        obj.insert("y".into(), json!(y));
        changed.push("y".into());
    }
    if let Some(w) = patch.w {
        if obj.get("type").and_then(|v| v.as_str()) == Some("ellipse") {
            obj.insert("radiusX".into(), json!(w / 2.0));
        } else if obj.contains_key("width") {
            obj.insert("width".into(), json!(w));
        }
        changed.push("w".into());
    }
    if let Some(h) = patch.h {
        if obj.get("type").and_then(|v| v.as_str()) == Some("ellipse") {
            obj.insert("radiusY".into(), json!(h / 2.0));
        } else if obj.contains_key("height") {
            obj.insert("height".into(), json!(h));
        }
        changed.push("h".into());
    }
    if let Some(text) = &patch.text {
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "text" {
            obj.insert("content".into(), json!(text));
        } else {
            obj.insert("label".into(), json!(text));
        }
        changed.push("text".into());
    }
    if let Some(style) = &patch.style {
        if let Some(fill) = &style.fill {
            obj.insert("fill".into(), json!(normalize_auto(fill.clone())));
            changed.push("style.fill".into());
        }
        if let Some(stroke) = &style.stroke {
            obj.insert("stroke".into(), json!(normalize_auto(stroke.clone())));
            changed.push("style.stroke".into());
        }
        if let Some(sw) = style.stroke_width {
            obj.insert("strokeWidth".into(), json!(sw));
            changed.push("style.strokeWidth".into());
        }
        if let Some(lc) = &style.label_color {
            obj.insert("labelColor".into(), json!(normalize_auto(lc.clone())));
            changed.push("style.labelColor".into());
        }
    }
    if let Some(icon_id) = &patch.icon_id {
        // Empty string clears the icon (mirrors the editor's handleUpdate).
        obj.insert("iconId".into(), json!(icon_id));
        changed.push("iconId".into());
    }
    if let Some(mode) = patch
        .icon_display_mode
        .as_deref()
        .and_then(normalize_icon_display_mode)
    {
        obj.insert("iconDisplayMode".into(), json!(mode));
        changed.push("iconDisplayMode".into());
    }
    if let Some(size) = patch.icon_size {
        obj.insert("iconSize".into(), json!(size));
        changed.push("iconSize".into());
    }

    changed
}

/// Partial update DSL accepted by `docushark.update_shape`. Every field
/// is optional; absent fields are left untouched. To clear a field the
/// caller would need an explicit "reset" call (out of scope for v1).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DslPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub text: Option<String>,
    pub style: Option<DslStyle>,
    /// Set/replace the icon. An empty string clears it.
    pub icon_id: Option<String>,
    pub icon_display_mode: Option<String>,
    pub icon_size: Option<f64>,
    /// Keys serde didn't recognize, captured for `update_shape` to report
    /// instead of silently dropping (JP-312 "talk back"). Never applied.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, Value>,
}

/// A non-fatal adjustment a write tool made to the agent's input, surfaced in
/// the tool result's `fixes` array so the agent can self-correct in-loop rather
/// than discovering it on a verify read (JP-312 "talk back"). Mirrors the
/// `{action, reason}` vocabulary of `ProseFix` (`sync/prose_validate.rs`) so
/// prose and shape tools read consistently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeFix {
    /// The offending DSL field / key, e.g. "fillColor", "routingMode",
    /// "labelPosition", or "style.colour" for a nested style key.
    pub field: String,
    pub action: FixAction,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixAction {
    /// A key the DSL doesn't recognize — dropped (most often a typo).
    DroppedUnknown,
    /// A recognized field carrying an unaccepted value — dropped, the field's
    /// default applies.
    DroppedInvalid,
    /// A value coerced into its allowed range.
    Clamped,
}

fn dropped_invalid(field: &str, got: &str, accepted: &str) -> ShapeFix {
    ShapeFix {
        field: field.to_string(),
        action: FixAction::DroppedInvalid,
        reason: format!("'{got}' is not a valid {field} ({accepted}) — dropped, default applies"),
    }
}

fn unknown_key_fixes(prefix: &str, unknown: &serde_json::Map<String, Value>) -> Vec<ShapeFix> {
    unknown
        .keys()
        .map(|key| {
            let field = if prefix.is_empty() { key.clone() } else { format!("{prefix}{key}") };
            ShapeFix {
                reason: format!("'{field}' is not a recognized field — dropped"),
                field,
                action: FixAction::DroppedUnknown,
            }
        })
        .collect()
}

/// Report every adjustment [`dsl_to_shape_json`] would silently make to `dsl`:
/// unrecognized keys (top-level + nested `style`) are dropped, a *present* but
/// unaccepted `routingMode` / arrow style / `iconDisplayMode` is dropped to the
/// field default, and an out-of-range `labelPosition` is clamped. Empty when the
/// input is clean. Pure: it neither mutates `dsl` nor builds the shape, so it
/// can run alongside `dsl_to_shape_json` without changing what's persisted.
pub fn dsl_fixes(dsl: &DslShape) -> Vec<ShapeFix> {
    let mut fixes = unknown_key_fixes("", &dsl.unknown);
    if let Some(style) = &dsl.style {
        fixes.extend(unknown_key_fixes("style.", &style.unknown));
    }
    if let Some(v) = &dsl.routing_mode {
        if normalize_routing_mode(v).is_none() {
            fixes.push(dropped_invalid("routingMode", v, "straight | orthogonal | curved"));
        }
    }
    if let Some(v) = &dsl.start_arrow_style {
        if normalize_arrow_style(v).is_none() {
            fixes.push(dropped_invalid("startArrowStyle", v, "none | triangle | open | diamond"));
        }
    }
    if let Some(v) = &dsl.end_arrow_style {
        if normalize_arrow_style(v).is_none() {
            fixes.push(dropped_invalid("endArrowStyle", v, "none | triangle | open | diamond"));
        }
    }
    if let Some(v) = &dsl.icon_display_mode {
        if normalize_icon_display_mode(v).is_none() {
            fixes.push(dropped_invalid("iconDisplayMode", v, "inside | badge | icon-only"));
        }
    }
    if let Some(lp) = dsl.label_position {
        if !(0.0..=1.0).contains(&lp) {
            fixes.push(ShapeFix {
                field: "labelPosition".into(),
                action: FixAction::Clamped,
                reason: format!("labelPosition {lp} clamped to {}", lp.clamp(0.0, 1.0)),
            });
        }
    }
    fixes
}

/// Report adjustments [`apply_dsl_patch`] would silently make: unrecognized keys
/// (top-level + nested `style`) dropped, and an unaccepted `iconDisplayMode`
/// dropped. Empty when clean. Pure (does not apply the patch).
pub fn dsl_patch_fixes(patch: &DslPatch) -> Vec<ShapeFix> {
    let mut fixes = unknown_key_fixes("", &patch.unknown);
    if let Some(style) = &patch.style {
        fixes.extend(unknown_key_fixes("style.", &style.unknown));
    }
    if let Some(v) = &patch.icon_display_mode {
        if normalize_icon_display_mode(v).is_none() {
            fixes.push(dropped_invalid("iconDisplayMode", v, "inside | badge | icon-only"));
        }
    }
    fixes
}

/// Lossy reverse mapping used by read tools so an LLM sees the same DSL
/// shape it would write. Unknown shape types are returned as `None` so the
/// caller can fall back to a generic representation.
pub fn shape_json_to_dsl(shape: &Value) -> Option<Value> {
    let kind = shape.get("type")?.as_str()?;
    let x = shape.get("x")?.as_f64()?;
    let y = shape.get("y")?.as_f64()?;

    let (dsl_kind, w, h) = match kind {
        "rectangle" => (
            "rectangle",
            shape.get("width").and_then(|v| v.as_f64()),
            shape.get("height").and_then(|v| v.as_f64()),
        ),
        "ellipse" => (
            "ellipse",
            shape.get("radiusX").and_then(|v| v.as_f64()).map(|r| r * 2.0),
            shape.get("radiusY").and_then(|v| v.as_f64()).map(|r| r * 2.0),
        ),
        "text" => (
            "text",
            shape.get("width").and_then(|v| v.as_f64()),
            shape.get("height").and_then(|v| v.as_f64()),
        ),
        "connector" => ("connector", None, None),
        _ => return None,
    };

    let mut out = json!({
        "id": shape.get("id"),
        "kind": dsl_kind,
        "x": x,
        "y": y,
    });

    if let Some(w) = w {
        out["w"] = json!(w);
    }
    if let Some(h) = h {
        out["h"] = json!(h);
    }
    if let Some(label) = shape.get("label").and_then(|v| v.as_str()) {
        out["text"] = json!(label);
    } else if let Some(content) = shape.get("content").and_then(|v| v.as_str()) {
        // text shape uses `content` rather than `label`
        out["text"] = json!(content);
    }

    let mut style = json!({});
    let mut any_style = false;
    for key in ["fill", "stroke", "labelColor"] {
        if let Some(v) = shape.get(key) {
            if !v.is_null() {
                style[key] = v.clone();
                any_style = true;
            }
        }
    }
    if let Some(sw) = shape.get("strokeWidth") {
        style["strokeWidth"] = sw.clone();
        any_style = true;
    }
    if any_style {
        out["style"] = style;
    }

    // Surface icon fields so a read shows the same DSL a write would set.
    for key in ["iconId", "iconDisplayMode", "iconSize"] {
        if let Some(v) = shape.get(key) {
            if !v.is_null() {
                out[key] = v.clone();
            }
        }
    }

    if dsl_kind == "connector" {
        if let Some(v) = shape.get("startShapeId").cloned() {
            out["startShapeId"] = v;
        }
        if let Some(v) = shape.get("endShapeId").cloned() {
            out["endShapeId"] = v;
        }
        if let Some(v) = shape.get("startAnchor").cloned() {
            out["startAnchor"] = v;
        }
        if let Some(v) = shape.get("endAnchor").cloned() {
            out["endAnchor"] = v;
        }
        if let Some(v) = shape.get("routingMode").cloned() {
            out["routingMode"] = v;
        }
        if let Some(v) = shape.get("waypoints").cloned() {
            out["waypoints"] = v;
        }
        if let Some(v) = shape.get("labelPosition").cloned() {
            out["labelPosition"] = v;
        }
    }

    Some(out)
}

// ---------------------------------------------------------------------------
// Per-kind builders. Keep field names and defaults in sync with the TS
// handlers in src/shapes/{Rectangle,Ellipse,Text}.ts.
// ---------------------------------------------------------------------------

fn base_object(id: &str, ty: &str, dsl: &DslShape) -> serde_json::Map<String, Value> {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), json!(id));
    o.insert("type".into(), json!(ty));
    o.insert("x".into(), json!(dsl.x));
    o.insert("y".into(), json!(dsl.y));
    o.insert("rotation".into(), json!(0));
    o.insert("opacity".into(), json!(1));
    o.insert("locked".into(), json!(false));
    o.insert("visible".into(), json!(true));
    o
}

fn rectangle(dsl: &DslShape, id: &str) -> Value {
    let mut o = base_object(id, "rectangle", dsl);
    let (fill, stroke, stroke_width, label_color) = resolve_style(
        dsl.style.as_ref(),
        // DEFAULT_SHAPE_STYLE
        Some("#4a90d9"),
        Some("#2c5282"),
        2.0,
        None,
    );
    o.insert("fill".into(), value_or_null(fill));
    o.insert("stroke".into(), value_or_null(stroke));
    o.insert("strokeWidth".into(), json!(stroke_width));
    o.insert("width".into(), json!(dsl.w.unwrap_or(100.0)));
    o.insert("height".into(), json!(dsl.h.unwrap_or(80.0)));
    o.insert("cornerRadius".into(), json!(0));
    if let Some(label) = &dsl.text {
        o.insert("label".into(), json!(label));
    }
    if let Some(c) = label_color {
        o.insert("labelColor".into(), json!(c));
    }
    apply_icon_fields(
        &mut o,
        dsl.icon_id.as_ref(),
        dsl.icon_display_mode.as_ref(),
        dsl.icon_size,
    );
    Value::Object(o)
}

fn ellipse(dsl: &DslShape, id: &str) -> Value {
    let mut o = base_object(id, "ellipse", dsl);
    let (fill, stroke, stroke_width, label_color) = resolve_style(
        dsl.style.as_ref(),
        Some("#4a90d9"),
        Some("#2c5282"),
        2.0,
        None,
    );
    o.insert("fill".into(), value_or_null(fill));
    o.insert("stroke".into(), value_or_null(stroke));
    o.insert("strokeWidth".into(), json!(stroke_width));
    // Diameter → radius. Defaults from DEFAULT_ELLIPSE (radiusX=50, radiusY=40).
    let rx = dsl.w.map(|w| w / 2.0).unwrap_or(50.0);
    let ry = dsl.h.map(|h| h / 2.0).unwrap_or(40.0);
    o.insert("radiusX".into(), json!(rx));
    o.insert("radiusY".into(), json!(ry));
    if let Some(label) = &dsl.text {
        o.insert("label".into(), json!(label));
    }
    if let Some(c) = label_color {
        o.insert("labelColor".into(), json!(c));
    }
    apply_icon_fields(
        &mut o,
        dsl.icon_id.as_ref(),
        dsl.icon_display_mode.as_ref(),
        dsl.icon_size,
    );
    Value::Object(o)
}

fn connector(dsl: &DslShape, id: &str) -> Value {
    let mut o = base_object(id, "connector", dsl);
    // DEFAULT_CONNECTOR: fill=null, stroke="auto", strokeWidth=2,
    // startArrow=false, endArrow=true, anchors=center.
    let (fill, stroke, stroke_width, label_color) =
        resolve_style(dsl.style.as_ref(), None, Some("auto"), 2.0, None);
    o.insert("fill".into(), value_or_null(fill));
    o.insert("stroke".into(), value_or_null(stroke));
    o.insert("strokeWidth".into(), json!(stroke_width));
    o.insert(
        "startShapeId".into(),
        match &dsl.start_shape_id {
            Some(id) => json!(id),
            None => Value::Null,
        },
    );
    o.insert(
        "endShapeId".into(),
        match &dsl.end_shape_id {
            Some(id) => json!(id),
            None => Value::Null,
        },
    );
    o.insert(
        "startAnchor".into(),
        json!(dsl.start_anchor.clone().unwrap_or_else(|| "center".into())),
    );
    o.insert(
        "endAnchor".into(),
        json!(dsl.end_anchor.clone().unwrap_or_else(|| "center".into())),
    );
    // The renderer recalculates `x2`/`y2` from the connected shapes each
    // frame; seeding (with the explicit end point when given, else the start
    // coords) keeps the first paint sensible before that recalculation.
    o.insert("x2".into(), json!(dsl.x2.unwrap_or(dsl.x)));
    o.insert("y2".into(), json!(dsl.y2.unwrap_or(dsl.y)));
    // Routed-path fields (JP-245). Emitted only when set so connectors from
    // `connect`/`add_shape` stay byte-identical to pre-routing output; the
    // field names mirror `ConnectorShape` in `src/shapes/Shape.ts` exactly.
    if let Some(mode) = dsl.routing_mode.as_deref().and_then(normalize_routing_mode) {
        o.insert("routingMode".into(), json!(mode));
    }
    if let Some(wps) = &dsl.waypoints {
        let points: Vec<Value> = wps.iter().map(|p| json!({"x": p.x, "y": p.y})).collect();
        o.insert("waypoints".into(), Value::Array(points));
    }
    if let Some(lp) = dsl.label_position {
        o.insert("labelPosition".into(), json!(lp.clamp(0.0, 1.0)));
    }
    // Per-endpoint arrow style. Defaults match `DEFAULT_CONNECTOR`: no head
    // at the start, a filled triangle at the end. Mirror to the legacy
    // boolean fields so older renderers / consumers stay in sync.
    let start_arrow_style = dsl
        .start_arrow_style
        .as_deref()
        .and_then(normalize_arrow_style)
        .unwrap_or("none");
    let end_arrow_style = dsl
        .end_arrow_style
        .as_deref()
        .and_then(normalize_arrow_style)
        .unwrap_or("triangle");
    o.insert("startArrowStyle".into(), json!(start_arrow_style));
    o.insert("endArrowStyle".into(), json!(end_arrow_style));
    o.insert("startArrow".into(), json!(start_arrow_style != "none"));
    o.insert("endArrow".into(), json!(end_arrow_style != "none"));
    if let Some(label) = &dsl.text {
        o.insert("label".into(), json!(label));
    }
    if let Some(c) = label_color {
        o.insert("labelColor".into(), json!(c));
    }
    Value::Object(o)
}

fn text(dsl: &DslShape, id: &str) -> Value {
    let mut o = base_object(id, "text", dsl);
    // DEFAULT_TEXT: fill=null, stroke=null, strokeWidth=0
    let (fill, stroke, stroke_width, label_color) =
        resolve_style(dsl.style.as_ref(), None, None, 0.0, Some("auto"));
    o.insert("fill".into(), value_or_null(fill));
    o.insert("stroke".into(), value_or_null(stroke));
    o.insert("strokeWidth".into(), json!(stroke_width));
    o.insert("width".into(), json!(dsl.w.unwrap_or(200.0)));
    o.insert("height".into(), json!(dsl.h.unwrap_or(50.0)));
    o.insert("fontSize".into(), json!(16));
    o.insert("fontFamily".into(), json!("sans-serif"));
    o.insert("textAlign".into(), json!("left"));
    o.insert("verticalAlign".into(), json!("top"));
    o.insert("content".into(), json!(dsl.text.clone().unwrap_or_default()));
    if let Some(c) = label_color {
        o.insert("labelColor".into(), json!(c));
    }
    Value::Object(o)
}

fn resolve_style(
    style: Option<&DslStyle>,
    default_fill: Option<&str>,
    default_stroke: Option<&str>,
    default_stroke_width: f64,
    default_label_color: Option<&str>,
) -> (Option<String>, Option<String>, f64, Option<String>) {
    let fill = style
        .and_then(|s| s.fill.clone())
        .map(normalize_auto)
        .or_else(|| default_fill.map(String::from));
    let stroke = style
        .and_then(|s| s.stroke.clone())
        .map(normalize_auto)
        .or_else(|| default_stroke.map(String::from));
    let stroke_width = style
        .and_then(|s| s.stroke_width)
        .unwrap_or(default_stroke_width);
    let label_color = style
        .and_then(|s| s.label_color.clone())
        .map(normalize_auto)
        .or_else(|| default_label_color.map(String::from));
    (fill, stroke, stroke_width, label_color)
}

fn normalize_auto(s: String) -> String {
    if s.eq_ignore_ascii_case("auto") {
        "auto".to_string()
    } else {
        s
    }
}

fn value_or_null(opt: Option<String>) -> Value {
    match opt {
        Some(s) => json!(s),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(kind: DslKind, x: f64, y: f64) -> DslShape {
        DslShape {
            kind,
            x,
            y,
            w: None,
            h: None,
            text: None,
            style: None,
            id: None,
            icon_id: None,
            icon_display_mode: None,
            icon_size: None,
            start_shape_id: None,
            end_shape_id: None,
            start_anchor: None,
            end_anchor: None,
            start_arrow_style: None,
            end_arrow_style: None,
            routing_mode: None,
            waypoints: None,
            label_position: None,
            x2: None,
            y2: None,
            unknown: serde_json::Map::new(),
        }
    }

    #[test]
    fn rectangle_defaults_match_typescript() {
        let s = dsl_to_shape_json(&make(DslKind::Rectangle, 10.0, 20.0), "r1");
        assert_eq!(s["type"], "rectangle");
        assert_eq!(s["x"], 10.0);
        assert_eq!(s["y"], 20.0);
        assert_eq!(s["width"], 100.0);
        assert_eq!(s["height"], 80.0);
        assert_eq!(s["fill"], "#4a90d9");
        assert_eq!(s["stroke"], "#2c5282");
        assert_eq!(s["strokeWidth"], 2.0);
        assert_eq!(s["rotation"], 0);
        assert_eq!(s["cornerRadius"], 0);
    }

    #[test]
    fn ellipse_converts_diameter_to_radius() {
        let mut d = make(DslKind::Ellipse, 0.0, 0.0);
        d.w = Some(200.0);
        d.h = Some(80.0);
        let s = dsl_to_shape_json(&d, "e1");
        assert_eq!(s["radiusX"], 100.0);
        assert_eq!(s["radiusY"], 40.0);
    }

    #[test]
    fn text_defaults_have_null_fill_and_stroke() {
        let mut d = make(DslKind::Text, 5.0, 5.0);
        d.text = Some("hello".into());
        let s = dsl_to_shape_json(&d, "t1");
        assert_eq!(s["type"], "text");
        assert!(s["fill"].is_null());
        assert!(s["stroke"].is_null());
        assert_eq!(s["strokeWidth"], 0.0);
        assert_eq!(s["content"], "hello");
        assert_eq!(s["labelColor"], "auto");
    }

    #[test]
    fn auto_sentinel_is_normalized_case_insensitively() {
        let mut d = make(DslKind::Rectangle, 0.0, 0.0);
        d.style = Some(DslStyle {
            fill: Some("AUTO".into()),
            stroke: Some("Auto".into()),
            stroke_width: None,
            label_color: Some("auto".into()),
            ..Default::default()
        });
        let s = dsl_to_shape_json(&d, "r");
        assert_eq!(s["fill"], "auto");
        assert_eq!(s["stroke"], "auto");
        assert_eq!(s["labelColor"], "auto");
    }

    #[test]
    fn label_is_propagated_for_rectangle() {
        let mut d = make(DslKind::Rectangle, 0.0, 0.0);
        d.text = Some("Box".into());
        let s = dsl_to_shape_json(&d, "r");
        assert_eq!(s["label"], "Box");
    }

    #[test]
    fn reverse_mapping_round_trips_basics() {
        let mut d = make(DslKind::Rectangle, 50.0, 60.0);
        d.w = Some(120.0);
        d.h = Some(40.0);
        d.text = Some("hi".into());
        let shape = dsl_to_shape_json(&d, "r1");

        let back = shape_json_to_dsl(&shape).expect("should map back");
        assert_eq!(back["kind"], "rectangle");
        assert_eq!(back["x"], 50.0);
        assert_eq!(back["y"], 60.0);
        assert_eq!(back["w"], 120.0);
        assert_eq!(back["h"], 40.0);
        assert_eq!(back["text"], "hi");
    }

    #[test]
    fn reverse_mapping_returns_none_for_unknown_type() {
        let shape = json!({"type": "file", "x": 0, "y": 0});
        assert!(shape_json_to_dsl(&shape).is_none());
    }

    #[test]
    fn connector_uses_default_arrows_and_anchors() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        let s = dsl_to_shape_json(&d, "c1");
        assert_eq!(s["type"], "connector");
        assert_eq!(s["startShapeId"], "a");
        assert_eq!(s["endShapeId"], "b");
        assert_eq!(s["startAnchor"], "center");
        assert_eq!(s["endAnchor"], "center");
        assert_eq!(s["startArrow"], false);
        assert_eq!(s["endArrow"], true);
        assert_eq!(s["startArrowStyle"], "none");
        assert_eq!(s["endArrowStyle"], "triangle");
        assert_eq!(s["stroke"], "auto");
    }

    #[test]
    fn connector_arrow_styles_round_trip_and_mirror_boolean() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.start_arrow_style = Some("diamond".into());
        d.end_arrow_style = Some("open".into());
        let s = dsl_to_shape_json(&d, "c1");
        assert_eq!(s["startArrowStyle"], "diamond");
        assert_eq!(s["endArrowStyle"], "open");
        // Mirrored booleans: any non-"none" style flips the legacy flag on.
        assert_eq!(s["startArrow"], true);
        assert_eq!(s["endArrow"], true);
    }

    #[test]
    fn connector_arrow_style_none_clears_legacy_boolean() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.end_arrow_style = Some("none".into());
        let s = dsl_to_shape_json(&d, "c1");
        assert_eq!(s["endArrowStyle"], "none");
        assert_eq!(s["endArrow"], false);
    }

    #[test]
    fn connector_invalid_arrow_style_falls_back_to_default() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.start_arrow_style = Some("wedge".into()); // not one of the four
        let s = dsl_to_shape_json(&d, "c1");
        assert_eq!(s["startArrowStyle"], "none");
        assert_eq!(s["startArrow"], false);
    }

    #[test]
    fn connector_custom_anchors_propagate() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.start_anchor = Some("right".into());
        d.end_anchor = Some("left".into());
        let s = dsl_to_shape_json(&d, "c1");
        assert_eq!(s["startAnchor"], "right");
        assert_eq!(s["endAnchor"], "left");
    }

    #[test]
    fn connector_reverse_mapping_preserves_endpoints() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.start_anchor = Some("top".into());
        let s = dsl_to_shape_json(&d, "c1");
        let back = shape_json_to_dsl(&s).unwrap();
        assert_eq!(back["kind"], "connector");
        assert_eq!(back["startShapeId"], "a");
        assert_eq!(back["endShapeId"], "b");
        assert_eq!(back["startAnchor"], "top");
    }

    #[test]
    fn patch_updates_known_fields_and_reports_paths() {
        let mut d = make(DslKind::Rectangle, 0.0, 0.0);
        d.text = Some("orig".into());
        let mut s = dsl_to_shape_json(&d, "r1");

        let patch = DslPatch {
            x: Some(50.0),
            w: Some(200.0),
            text: Some("new".into()),
            style: Some(DslStyle {
                fill: Some("AUTO".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let changed = apply_dsl_patch(&mut s, &patch);

        assert_eq!(s["x"], 50.0);
        assert_eq!(s["width"], 200.0);
        assert_eq!(s["label"], "new");
        assert_eq!(s["fill"], "auto");
        assert!(changed.iter().any(|c| c == "x"));
        assert!(changed.iter().any(|c| c == "w"));
        assert!(changed.iter().any(|c| c == "text"));
        assert!(changed.iter().any(|c| c == "style.fill"));
    }

    #[test]
    fn patch_updates_ellipse_radius_via_w_h() {
        let d = make(DslKind::Ellipse, 0.0, 0.0);
        let mut s = dsl_to_shape_json(&d, "e1");
        let patch = DslPatch {
            w: Some(80.0),
            h: Some(40.0),
            ..Default::default()
        };
        apply_dsl_patch(&mut s, &patch);
        assert_eq!(s["radiusX"], 40.0);
        assert_eq!(s["radiusY"], 20.0);
    }

    #[test]
    fn patch_text_kind_updates_content_not_label() {
        let mut d = make(DslKind::Text, 0.0, 0.0);
        d.text = Some("old".into());
        let mut s = dsl_to_shape_json(&d, "t1");
        let patch = DslPatch {
            text: Some("new".into()),
            ..Default::default()
        };
        apply_dsl_patch(&mut s, &patch);
        assert_eq!(s["content"], "new");
        assert!(s.get("label").map(|v| v.is_null()).unwrap_or(true));
    }

    // ---- JP-245: routed-path connector fields ----

    #[test]
    fn connector_emits_routed_path_fields_when_set() {
        let mut d = make(DslKind::Connector, 10.0, 20.0);
        d.routing_mode = Some("orthogonal".into());
        d.waypoints = Some(vec![DslPoint { x: 50.0, y: 20.0 }, DslPoint { x: 50.0, y: 90.0 }]);
        d.label_position = Some(0.35);
        d.x2 = Some(120.0);
        d.y2 = Some(90.0);
        let s = dsl_to_shape_json(&d, "c1");
        // Field names mirror ConnectorShape in src/shapes/Shape.ts exactly.
        assert_eq!(s["routingMode"], "orthogonal");
        assert_eq!(s["waypoints"], json!([{"x": 50.0, "y": 20.0}, {"x": 50.0, "y": 90.0}]));
        assert_eq!(s["labelPosition"], 0.35);
        assert_eq!(s["x2"], 120.0);
        assert_eq!(s["y2"], 90.0);
    }

    #[test]
    fn connector_omits_routed_path_fields_when_unset() {
        // `connect`/`add_shape` connectors must stay byte-identical to the
        // pre-routing output: absent fields, not nulls or defaults.
        let s = dsl_to_shape_json(&make(DslKind::Connector, 10.0, 20.0), "c1");
        let o = s.as_object().unwrap();
        assert!(!o.contains_key("routingMode"));
        assert!(!o.contains_key("waypoints"));
        assert!(!o.contains_key("labelPosition"));
        // x2/y2 keep seeding from the start coords when no end point given.
        assert_eq!(s["x2"], 10.0);
        assert_eq!(s["y2"], 20.0);
    }

    #[test]
    fn connector_drops_invalid_routing_mode_and_clamps_label_position() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.routing_mode = Some("zigzag".into());
        d.label_position = Some(1.5);
        let s = dsl_to_shape_json(&d, "c1");
        assert!(!s.as_object().unwrap().contains_key("routingMode"));
        assert_eq!(s["labelPosition"], 1.0);
    }

    #[test]
    fn reverse_mapping_surfaces_routed_path_fields() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.start_shape_id = Some("a".into());
        d.end_shape_id = Some("b".into());
        d.routing_mode = Some("orthogonal".into());
        d.waypoints = Some(vec![DslPoint { x: 5.0, y: 6.0 }]);
        d.label_position = Some(0.65);
        let s = dsl_to_shape_json(&d, "c1");
        let back = shape_json_to_dsl(&s).unwrap();
        assert_eq!(back["routingMode"], "orthogonal");
        assert_eq!(back["waypoints"], json!([{"x": 5.0, "y": 6.0}]));
        assert_eq!(back["labelPosition"], 0.65);
    }

    // ---- JP-312 "talk back": dsl_fixes / dsl_patch_fixes ----

    #[test]
    fn dsl_fixes_empty_for_fully_populated_valid_shape() {
        // Every known field set, via the wire (camelCase) so this also guards the
        // serde(flatten) wiring: a mis-renamed known field would be captured as
        // "unknown" and surface a false-positive fix, failing here.
        let dsl: DslShape = serde_json::from_value(json!({
            "kind": "connector", "x": 0, "y": 0, "w": 10, "h": 10, "text": "t",
            "style": {"fill": "#fff", "stroke": "#000", "strokeWidth": 2, "labelColor": "auto"},
            "id": "c1", "iconId": "builtin:x", "iconDisplayMode": "inside", "iconSize": 24,
            "startShapeId": "a", "endShapeId": "b", "startAnchor": "center", "endAnchor": "center",
            "startArrowStyle": "none", "endArrowStyle": "triangle", "routingMode": "orthogonal",
            "waypoints": [{"x": 1, "y": 2}], "labelPosition": 0.5, "x2": 5, "y2": 5,
        }))
        .unwrap();
        assert!(dsl.unknown.is_empty(), "no known field should fall through to unknown");
        assert!(dsl_fixes(&dsl).is_empty(), "clean input → no fixes: {:?}", dsl_fixes(&dsl));
    }

    #[test]
    fn dsl_fixes_reports_unknown_keys_top_level_and_nested_style() {
        let dsl: DslShape = serde_json::from_value(json!({
            "kind": "rectangle", "x": 0, "y": 0,
            "fillColor": "#f00",                 // top-level typo for style.fill
            "style": {"fill": "#0f0", "colour": "blue"},  // nested typo for color/labelColor
        }))
        .unwrap();
        let fixes = dsl_fixes(&dsl);
        assert_eq!(fixes.len(), 2, "{fixes:?}");
        assert!(fixes.iter().any(|f| f.field == "fillColor" && f.action == FixAction::DroppedUnknown));
        assert!(fixes.iter().any(|f| f.field == "style.colour" && f.action == FixAction::DroppedUnknown));
    }

    #[test]
    fn dsl_fixes_reports_present_but_invalid_modes() {
        let dsl: DslShape = serde_json::from_value(json!({
            "kind": "connector", "x": 0, "y": 0,
            "routingMode": "zigzag", "endArrowStyle": "wedge", "iconDisplayMode": "nope",
        }))
        .unwrap();
        let fixes = dsl_fixes(&dsl);
        assert_eq!(fixes.len(), 3, "{fixes:?}");
        for field in ["routingMode", "endArrowStyle", "iconDisplayMode"] {
            assert!(
                fixes.iter().any(|f| f.field == field && f.action == FixAction::DroppedInvalid),
                "missing dropped_invalid for {field}: {fixes:?}"
            );
        }
    }

    #[test]
    fn dsl_fixes_clamps_out_of_range_label_position_only() {
        let mut d = make(DslKind::Connector, 0.0, 0.0);
        d.label_position = Some(1.5);
        let fixes = dsl_fixes(&d);
        assert_eq!(fixes.len(), 1);
        assert_eq!(fixes[0].field, "labelPosition");
        assert_eq!(fixes[0].action, FixAction::Clamped);

        // In-range and absent both produce nothing.
        d.label_position = Some(0.5);
        assert!(dsl_fixes(&d).is_empty());
        d.label_position = None;
        assert!(dsl_fixes(&d).is_empty());
    }

    #[test]
    fn dsl_patch_fixes_reports_unknown_and_invalid_only() {
        let patch: DslPatch = serde_json::from_value(json!({
            "x": 5, "bogus": 1, "iconDisplayMode": "huh",
        }))
        .unwrap();
        let fixes = dsl_patch_fixes(&patch);
        assert_eq!(fixes.len(), 2, "{fixes:?}");
        assert!(fixes.iter().any(|f| f.field == "bogus" && f.action == FixAction::DroppedUnknown));
        assert!(fixes.iter().any(|f| f.field == "iconDisplayMode" && f.action == FixAction::DroppedInvalid));

        // A clean patch reports nothing.
        let clean: DslPatch = serde_json::from_value(json!({"x": 5, "text": "ok"})).unwrap();
        assert!(dsl_patch_fixes(&clean).is_empty());
    }

    #[test]
    fn icon_fields_build_patch_and_reverse_map() {
        // Builder: a valid icon + mode is applied; unknown mode is dropped.
        let mut d = make(DslKind::Rectangle, 0.0, 0.0);
        d.icon_id = Some("builtin:aws-amazon-s3".into());
        d.icon_display_mode = Some("icon-only".into());
        d.icon_size = Some(48.0);
        let s = dsl_to_shape_json(&d, "r1");
        assert_eq!(s["iconId"], "builtin:aws-amazon-s3");
        assert_eq!(s["iconDisplayMode"], "icon-only");
        assert_eq!(s["iconSize"], 48.0);

        // A read shows the same icon DSL a write set.
        let back = shape_json_to_dsl(&s).unwrap();
        assert_eq!(back["iconId"], "builtin:aws-amazon-s3");
        assert_eq!(back["iconDisplayMode"], "icon-only");

        // Empty icon id sets nothing.
        let mut blank = make(DslKind::Rectangle, 0.0, 0.0);
        blank.icon_id = Some(String::new());
        let bs = dsl_to_shape_json(&blank, "r2");
        assert!(bs.get("iconId").is_none(), "empty iconId is a no-op: {bs}");

        // Bogus display mode is ignored (renderer default applies).
        let mut bad = make(DslKind::Rectangle, 0.0, 0.0);
        bad.icon_id = Some("builtin:database".into());
        bad.icon_display_mode = Some("nope".into());
        let bds = dsl_to_shape_json(&bad, "r3");
        assert_eq!(bds["iconId"], "builtin:database");
        assert!(bds.get("iconDisplayMode").is_none(), "bad mode dropped");

        // Patch: set then clear via empty string.
        let patch = DslPatch {
            icon_id: Some("builtin:redis".into()),
            icon_display_mode: Some("badge".into()),
            ..Default::default()
        };
        let mut shape = dsl_to_shape_json(&make(DslKind::Rectangle, 0.0, 0.0), "r4");
        let changed = apply_dsl_patch(&mut shape, &patch);
        assert_eq!(shape["iconId"], "builtin:redis");
        assert_eq!(shape["iconDisplayMode"], "badge");
        assert!(changed.contains(&"iconId".to_string()));
    }
}
