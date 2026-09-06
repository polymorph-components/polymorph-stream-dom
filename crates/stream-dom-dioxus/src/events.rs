//! dioxus-html event conversion over the `polymorph:stream-dom` event
//! payloads.
//!
//! `handle-event` hands the guest an encoded `EventPayload`
//! (proto/stream-dom-events.proto) whose family the receiver chose by event
//! name. Dioxus, in turn, asks a renderer to convert an opaque
//! [`dioxus_html::PlatformEventData`] into a family-specific `*Data` on
//! demand, through the global [`dioxus_html::HtmlEventConverter`]. This
//! module bridges the two, ported from polyengine-dioxus's `src/events.rs`
//! (`WitEventConverter` / `WitEventData` / the `PlatformEventData` downcast)
//! with only the families this spike's demo needs filled in.
//!
//! Filled in: `mouse` (click, dblclick and kin), `keyboard`, `form`, and
//! `focus` — the last of which carries no data at all, by design
//! (proto/stream-dom-events.proto's file header: "No case set is the empty
//! payload — focus, selection, toggle, ..."). Every other family converts to
//! [`Empty`], the neutral value a renderer returns when the platform does not
//! supply the information: those events still *dispatch*, their handlers just
//! see zeroed data. Deliberate scope, not an oversight — the other ~1000
//! lines of polyengine-dioxus's converter are the thing this spike does not
//! need to re-prove.
//!
//! A mismatched arm (a keyboard payload arriving for a mouse family, which a
//! correct receiver never sends) degrades to the neutral value rather than
//! panicking: a malformed receiver must not take the app down.
//!
//! This module names no WIT bindings, so it builds and tests natively.

use dioxus_html::geometry::{ClientPoint, ElementPoint, PagePoint, ScreenPoint};
use dioxus_html::input_data::{keyboard_types, MouseButton, MouseButtonSet};
use dioxus_html::point_interaction::{
    InteractionElementOffset, InteractionLocation, ModifiersInteraction, PointerInteraction,
};
use dioxus_html::{
    AnimationData, CancelData, ClipboardData, Code, CompositionData, DataTransfer, DragData,
    FileData, FocusData, FormData, FormValue, HasAnimationData, HasCancelData, HasClipboardData,
    HasCompositionData, HasDataTransferData, HasDragData, HasFileData, HasFocusData, HasFormData,
    HasImageData, HasKeyboardData, HasMediaData, HasMouseData, HasPointerData, HasResizeData,
    HasScrollData, HasSelectionData, HasToggleData, HasTouchData, HasTransitionData,
    HasVisibleData, HasWheelData, HtmlEventConverter, ImageData, Key, KeyboardData, MediaData,
    Modifiers, MountedData, MouseData, NativeDataTransfer, PlatformEventData, PointerData,
    ResizeData, ScrollData, SelectionData, ToggleData, TouchData, TouchPoint, TransitionData,
    VisibleData, WheelData,
};
use stream_dom_guest::proto;

/// The platform event boxed into dioxus's [`PlatformEventData`]: one
/// dispatch's decoded payload, converted lazily by [`StreamEventConverter`].
pub struct StreamEventData {
    pub payload: proto::EventPayload,
}

impl StreamEventData {
    pub fn new(payload: proto::EventPayload) -> Self {
        Self { payload }
    }

    fn mouse(&self) -> proto::MouseData {
        match &self.payload.family {
            Some(proto::event_payload::Family::Mouse(m)) => *m,
            // Pointer and wheel payloads embed a full mouse snapshot, and the
            // corresponding dioxus data types are supertypes of HasMouseData,
            // so reading through is exactly right.
            Some(proto::event_payload::Family::Pointer(p)) => p.mouse.unwrap_or_default(),
            Some(proto::event_payload::Family::Wheel(w)) => w.mouse.unwrap_or_default(),
            _ => proto::MouseData::default(),
        }
    }
}

fn modifiers(mods: Option<proto::Modifiers>) -> Modifiers {
    let mods = mods.unwrap_or_default();
    let mut out = Modifiers::empty();
    out.set(Modifiers::ALT, mods.alt);
    out.set(Modifiers::CONTROL, mods.ctrl);
    out.set(Modifiers::META, mods.meta);
    out.set(Modifiers::SHIFT, mods.shift);
    out
}

/// A mouse snapshot wearing the dioxus pointer-interaction traits.
///
/// The four coordinate spaces are distinct types in dioxus (`euclid` phantom
/// units), so the mapping is explicit: client/page/screen come straight from
/// the DOM event; dioxus's "element" space is the DOM's `offsetX`/`offsetY`
/// (dioxus-html-0.7.10 src/point_interaction.rs).
struct Mouse(proto::MouseData);

impl InteractionLocation for Mouse {
    fn client_coordinates(&self) -> ClientPoint {
        ClientPoint::new(self.0.client_x, self.0.client_y)
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        ScreenPoint::new(self.0.screen_x, self.0.screen_y)
    }
    fn page_coordinates(&self) -> PagePoint {
        PagePoint::new(self.0.page_x, self.0.page_y)
    }
}

impl InteractionElementOffset for Mouse {
    fn element_coordinates(&self) -> ElementPoint {
        ElementPoint::new(self.0.offset_x, self.0.offset_y)
    }
}

impl ModifiersInteraction for Mouse {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.modifiers)
    }
}

impl PointerInteraction for Mouse {
    fn trigger_button(&self) -> Option<MouseButton> {
        // The proto's `MouseButton` values are the DOM's `MouseEvent.button`
        // codes (proto/stream-dom-events.proto: "the order differs from the
        // `buttons` bits"), which is exactly what `from_web_code` decodes.
        // Absent means no press or release caused this event, which dioxus
        // models as `None`.
        self.0
            .button
            .map(|code| MouseButton::from_web_code(code as i16))
    }
    fn held_buttons(&self) -> MouseButtonSet {
        // The proto spells the `buttons` bitmask out as named flags, so this
        // builds the set directly instead of going through
        // `decode_mouse_button_set`.
        let mut set = MouseButtonSet::empty();
        if self.0.primary {
            set |= MouseButton::Primary;
        }
        if self.0.secondary {
            set |= MouseButton::Secondary;
        }
        if self.0.auxiliary {
            set |= MouseButton::Auxiliary;
        }
        if self.0.back {
            set |= MouseButton::Fourth;
        }
        if self.0.forward {
            set |= MouseButton::Fifth;
        }
        set
    }
}

impl HasMouseData for Mouse {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct Keyboard(proto::KeyboardData);

impl ModifiersInteraction for Keyboard {
    fn modifiers(&self) -> Modifiers {
        modifiers(self.0.modifiers)
    }
}

impl HasKeyboardData for Keyboard {
    fn key(&self) -> Key {
        // `Key::from_str` maps printable key strings to `Key::Character` and
        // named keys to their variants; anything else is `Unidentified`,
        // which is what a renderer should surface rather than failing.
        self.0.key.parse().unwrap_or(Key::Unidentified)
    }
    fn code(&self) -> Code {
        self.0.code.parse().unwrap_or(Code::Unidentified)
    }
    fn location(&self) -> keyboard_types::Location {
        // The proto's `KeyLocation` values are the DOM's
        // `KeyboardEvent.location` codes.
        dioxus_html::input_data::decode_key_location(self.0.location as usize)
    }
    fn is_auto_repeating(&self) -> bool {
        self.0.repeat
    }
    fn is_composing(&self) -> bool {
        self.0.is_composing
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

struct Form(proto::FormData);

impl HasFileData for Form {
    fn files(&self) -> Vec<FileData> {
        // Files are a live host handle, not a snapshot, and the WIT has no
        // way to hand one over yet (docs/design.md "Events": "Files and
        // `DataTransfer` are resources ... not yet declared in the WIT").
        Vec::new()
    }
}

impl HasFormData for Form {
    fn value(&self) -> String {
        // CONTRACT: proto/stream-dom-events.proto carries `value` and
        // `checked` as separate fields, but dioxus 0.7.10's
        // `FormData::checked()` is *derived* — `self.value().parse::<bool>()`
        // (dioxus-html-0.7.10 src/events/form.rs:39). dioxus-web resolves
        // this by serializing a checkbox's value as "true"/"false"
        // (dioxus-interpreter-js is not involved; see dioxus-web-0.7.10
        // src/events/form.rs:36-42). So when the payload reports `checked`,
        // that is what `value()` must return for `evt.checked()` to work —
        // dioxus-web's policy in miniature, the same rule the writer's
        // attribute-vs-property table follows. A checkable control's literal
        // `value` attribute is unreachable through this trait either way,
        // because dioxus-web discards it too.
        match self.0.checked {
            Some(checked) => checked.to_string(),
            None => self.0.value.clone(),
        }
    }
    fn valid(&self) -> bool {
        // Constraint validation state is not carried on the wire; `true` is
        // the no-information default (a form reporting no problems).
        true
    }
    fn values(&self) -> Vec<(String, FormValue)> {
        self.0
            .fields
            .iter()
            .map(|f| (f.name.clone(), FormValue::Text(f.value.clone())))
            .collect()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// The neutral value for every family this adapter does not carry. See the
/// module doc: dispatch still happens, the handler just reads zeros.
struct Empty;

macro_rules! empty_as_any {
    ($($t:path),* $(,)?) => {$(
        impl $t for Empty {
            fn as_any(&self) -> &dyn std::any::Any {
                self
            }
        }
    )*};
}

empty_as_any!(
    HasCancelData,
    HasClipboardData,
    HasFocusData,
    HasMediaData,
    HasSelectionData,
    HasToggleData,
    // Resize and Visible take the trait's own `NotSupported` defaults for
    // every query; only `as_any` is mandatory.
    HasResizeData,
    HasVisibleData,
);

impl HasAnimationData for Empty {
    fn animation_name(&self) -> String {
        String::new()
    }
    fn pseudo_element(&self) -> String {
        String::new()
    }
    fn elapsed_time(&self) -> f32 {
        0.0
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasTransitionData for Empty {
    fn property_name(&self) -> String {
        String::new()
    }
    fn pseudo_element(&self) -> String {
        String::new()
    }
    fn elapsed_time(&self) -> f32 {
        0.0
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasCompositionData for Empty {
    fn data(&self) -> String {
        String::new()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasImageData for Empty {
    fn load_error(&self) -> bool {
        false
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasScrollData for Empty {
    fn scroll_top(&self) -> f64 {
        0.0
    }
    fn scroll_left(&self) -> f64 {
        0.0
    }
    fn scroll_width(&self) -> i32 {
        0
    }
    fn scroll_height(&self) -> i32 {
        0
    }
    fn client_width(&self) -> i32 {
        0
    }
    fn client_height(&self) -> i32 {
        0
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl ModifiersInteraction for Empty {
    fn modifiers(&self) -> Modifiers {
        Modifiers::empty()
    }
}

impl HasTouchData for Empty {
    fn touches(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn touches_changed(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn target_touches(&self) -> Vec<TouchPoint> {
        Vec::new()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasFileData for Empty {
    fn files(&self) -> Vec<FileData> {
        Vec::new()
    }
}

/// A `DataTransfer` backing that holds nothing: the real one is a live host
/// resource the WIT does not declare yet (docs/design.md "Events").
struct NoTransfer;

impl NativeDataTransfer for NoTransfer {
    fn get_data(&self, _format: &str) -> Option<String> {
        None
    }
    fn set_data(&self, _format: &str, _data: &str) -> Result<(), String> {
        Err("data transfer is not carried by polymorph:stream-dom".into())
    }
    fn clear_data(&self, _format: Option<&str>) -> Result<(), String> {
        Err("data transfer is not carried by polymorph:stream-dom".into())
    }
    fn effect_allowed(&self) -> String {
        String::new()
    }
    fn set_effect_allowed(&self, _effect: &str) {}
    fn drop_effect(&self) -> String {
        String::new()
    }
    fn set_drop_effect(&self, _effect: &str) {}
    fn files(&self) -> Vec<FileData> {
        Vec::new()
    }
}

/// A drag event. The protocol folds drag into the `mouse` family (its only
/// addition is the `DataTransfer` resource — docs/design.md "Events"), so the
/// positional half is a real [`Mouse`] and the transfer half is empty.
struct Drag(proto::MouseData);

impl InteractionLocation for Drag {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0).page_coordinates()
    }
}

impl InteractionElementOffset for Drag {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0).element_coordinates()
    }
}

impl ModifiersInteraction for Drag {
    fn modifiers(&self) -> Modifiers {
        Mouse(self.0).modifiers()
    }
}

impl PointerInteraction for Drag {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0).held_buttons()
    }
}

impl HasMouseData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasFileData for Drag {
    fn files(&self) -> Vec<FileData> {
        Vec::new()
    }
}

impl HasDataTransferData for Drag {
    fn data_transfer(&self) -> DataTransfer {
        DataTransfer::new(NoTransfer)
    }
}

impl HasDragData for Drag {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A pointer event: a mouse snapshot with neutral stylus geometry. The
/// `pointer` family is not carried, but `HasPointerData` is a supertype of
/// `PointerInteraction`, so the coordinates a pointer handler reads are real
/// whenever the receiver sent a mouse payload.
struct Pointer(proto::MouseData);

impl InteractionLocation for Pointer {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0).page_coordinates()
    }
}

impl InteractionElementOffset for Pointer {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0).element_coordinates()
    }
}

impl ModifiersInteraction for Pointer {
    fn modifiers(&self) -> Modifiers {
        Mouse(self.0).modifiers()
    }
}

impl PointerInteraction for Pointer {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0).held_buttons()
    }
}

impl HasPointerData for Pointer {
    fn pointer_id(&self) -> i32 {
        0
    }
    fn width(&self) -> f64 {
        0.0
    }
    fn height(&self) -> f64 {
        0.0
    }
    fn pressure(&self) -> f32 {
        0.0
    }
    fn tangential_pressure(&self) -> f32 {
        0.0
    }
    fn tilt_x(&self) -> i32 {
        0
    }
    fn tilt_y(&self) -> i32 {
        0
    }
    fn twist(&self) -> i32 {
        0
    }
    fn pointer_type(&self) -> String {
        String::new()
    }
    fn is_primary(&self) -> bool {
        false
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A wheel event: a mouse snapshot with no deltas. Same reasoning as
/// [`Pointer`].
struct Wheel(proto::MouseData);

impl InteractionLocation for Wheel {
    fn client_coordinates(&self) -> ClientPoint {
        Mouse(self.0).client_coordinates()
    }
    fn screen_coordinates(&self) -> ScreenPoint {
        Mouse(self.0).screen_coordinates()
    }
    fn page_coordinates(&self) -> PagePoint {
        Mouse(self.0).page_coordinates()
    }
}

impl InteractionElementOffset for Wheel {
    fn element_coordinates(&self) -> ElementPoint {
        Mouse(self.0).element_coordinates()
    }
}

impl ModifiersInteraction for Wheel {
    fn modifiers(&self) -> Modifiers {
        Mouse(self.0).modifiers()
    }
}

impl PointerInteraction for Wheel {
    fn trigger_button(&self) -> Option<MouseButton> {
        Mouse(self.0).trigger_button()
    }
    fn held_buttons(&self) -> MouseButtonSet {
        Mouse(self.0).held_buttons()
    }
}

impl HasMouseData for Wheel {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl HasWheelData for Wheel {
    fn delta(&self) -> dioxus_html::geometry::WheelDelta {
        dioxus_html::geometry::WheelDelta::from_web_attributes(0, 0.0, 0.0, 0.0)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Installs into dioxus-html's global converter slot (see
/// [`dioxus_html::set_event_converter`]); every `Event<XData>` a handler
/// receives is produced by one of these methods.
pub struct StreamEventConverter;

fn payload(event: &PlatformEventData) -> Option<&StreamEventData> {
    event.downcast::<StreamEventData>()
}

impl HtmlEventConverter for StreamEventConverter {
    fn convert_mouse_data(&self, event: &PlatformEventData) -> MouseData {
        MouseData::new(Mouse(
            payload(event)
                .map(StreamEventData::mouse)
                .unwrap_or_default(),
        ))
    }

    fn convert_keyboard_data(&self, event: &PlatformEventData) -> KeyboardData {
        let k = match payload(event).map(|p| &p.payload.family) {
            Some(Some(proto::event_payload::Family::Keyboard(k))) => k.clone(),
            _ => proto::KeyboardData::default(),
        };
        KeyboardData::new(Keyboard(k))
    }

    fn convert_form_data(&self, event: &PlatformEventData) -> FormData {
        let f = match payload(event).map(|p| &p.payload.family) {
            Some(Some(proto::event_payload::Family::Form(f))) => f.clone(),
            _ => proto::FormData::default(),
        };
        FormData::new(Form(f))
    }

    fn convert_focus_data(&self, _: &PlatformEventData) -> FocusData {
        // Focus carries nothing on the wire by design
        // (proto/stream-dom-events.proto file header) and `HasFocusData`'s
        // only method is `as_any`, so this is complete, not a stub.
        FocusData::new(Empty)
    }

    fn convert_drag_data(&self, event: &PlatformEventData) -> DragData {
        DragData::new(Drag(
            payload(event)
                .map(StreamEventData::mouse)
                .unwrap_or_default(),
        ))
    }

    fn convert_pointer_data(&self, event: &PlatformEventData) -> PointerData {
        PointerData::new(Pointer(
            payload(event)
                .map(StreamEventData::mouse)
                .unwrap_or_default(),
        ))
    }

    fn convert_wheel_data(&self, event: &PlatformEventData) -> WheelData {
        WheelData::new(Wheel(
            payload(event)
                .map(StreamEventData::mouse)
                .unwrap_or_default(),
        ))
    }

    fn convert_animation_data(&self, _: &PlatformEventData) -> AnimationData {
        AnimationData::new(Empty)
    }

    fn convert_cancel_data(&self, _: &PlatformEventData) -> CancelData {
        CancelData::new(Empty)
    }

    fn convert_clipboard_data(&self, _: &PlatformEventData) -> ClipboardData {
        ClipboardData::new(Empty)
    }

    fn convert_composition_data(&self, _: &PlatformEventData) -> CompositionData {
        CompositionData::new(Empty)
    }

    fn convert_image_data(&self, _: &PlatformEventData) -> ImageData {
        ImageData::new(Empty)
    }

    fn convert_media_data(&self, _: &PlatformEventData) -> MediaData {
        MediaData::new(Empty)
    }

    fn convert_mounted_data(&self, _: &PlatformEventData) -> MountedData {
        // `()` is dioxus's own no-capability backing, every query reporting
        // `NotSupported`. A real backing would go through the world's
        // `queries` import; not in this spike's scope.
        MountedData::new(())
    }

    fn convert_resize_data(&self, _: &PlatformEventData) -> ResizeData {
        ResizeData::new(Empty)
    }

    fn convert_scroll_data(&self, _: &PlatformEventData) -> ScrollData {
        ScrollData::new(Empty)
    }

    fn convert_selection_data(&self, _: &PlatformEventData) -> SelectionData {
        SelectionData::new(Empty)
    }

    fn convert_toggle_data(&self, _: &PlatformEventData) -> ToggleData {
        ToggleData::new(Empty)
    }

    fn convert_touch_data(&self, _: &PlatformEventData) -> TouchData {
        TouchData::new(Empty)
    }

    fn convert_transition_data(&self, _: &PlatformEventData) -> TransitionData {
        TransitionData::new(Empty)
    }

    fn convert_visible_data(&self, _: &PlatformEventData) -> VisibleData {
        VisibleData::new(Empty)
    }
}
