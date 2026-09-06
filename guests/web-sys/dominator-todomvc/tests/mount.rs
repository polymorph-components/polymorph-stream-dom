//! Does the real thing actually run?
//!
//! Everything else in this workspace proves the shims *compile* against
//! Dominator. This mounts Dominator's TodoMVC for real and reads the
//! frames it produces — the difference between "the strategy type-checks"
//! and "the strategy works".
//!
//! Native only, on the small executor in the `wasm-bindgen-futures` shim
//! (see its docs for why one poll per signal task is the initial render).

use dominator_todomvc::App;
use prost::Message;
use stream_dom_fakedom::dom;
use stream_dom_guest::proto::{self, frame::Op};

fn mount_and_take_frames() -> Vec<proto::Frame> {
    dominator::append_dom(&web_sys::mount_root_node(), App::render(App::new()));
    wasm_bindgen_futures::run_pending();

    let bytes = dom::take_batch().expect("the mount produced a batch");
    let mut buf = bytes.as_slice();
    let mut frames = Vec::new();
    while !buf.is_empty() {
        frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
    }
    frames
}

#[test]
fn todomvc_mounts_and_emits_its_markup() {
    let frames = mount_and_take_frames();

    let slot = |s: &str| {
        frames.iter().find_map(|f| match &f.op {
            Some(Op::Intern(i)) if i.s == s => Some(i.id),
            _ => None,
        })
    };

    // The markup TodoMVC's CSS keys off, all the way down to the filter
    // links this port rewired away from `history.pushState`.
    for tag in [
        "section", "header", "h1", "input", "label", "ul", "li", "a", "button", "footer",
    ] {
        assert!(slot(tag).is_some(), "no <{tag}> was created");
    }

    let class_slot = slot("class").expect("`class` was never interned");
    let classes: Vec<&str> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::SetAttribute(a)) if a.name == class_slot => a.value.as_deref(),
            _ => None,
        })
        .collect();
    for expected in [
        "todoapp",
        "header",
        "new-todo",
        "main",
        "toggle-all",
        "todo-list",
        "footer",
    ] {
        assert!(
            classes.iter().any(|c| c.split(' ').any(|t| t == expected)),
            "class {expected:?} never set; got {classes:?}"
        );
    }

    // `.focused(true)` on the new-todo input is an effect, not a frame.
    assert!(
        dom::take_effects()
            .iter()
            .any(|e| matches!(e, dom::Effect::Focus(_, true))),
        "the new-todo input should have asked for focus"
    );

    // Exactly one commit, on the last frame.
    let (last, rest) = frames.split_last().unwrap();
    assert!(last.commit);
    assert!(rest.iter().all(|f| !f.commit));

    // And every id an op names was created first (0 is the mount root).
    let mut created = vec![0u32];
    for f in &frames {
        match f.op.as_ref().unwrap() {
            Op::CreateElement(c) => created.push(c.id),
            Op::CreateText(c) => created.push(c.id),
            Op::CreatePlaceholder(c) => created.push(c.id),
            Op::InsertBefore(i) => {
                assert!(created.contains(&i.parent) && created.contains(&i.id));
                if let Some(a) = i.anchor {
                    assert!(created.contains(&a));
                }
            }
            _ => {}
        }
    }
}

/// The other half of the claim: an event arriving on `handle-event`
/// reaches the app's handlers, and the mutations the signals then make
/// come back out as frames.
#[test]
fn typing_a_todo_and_pressing_enter_creates_a_row() {
    let mount = mount_and_take_frames();
    // Interned slots are defined once per producer instance
    // (proto/stream-dom.proto file header), so the later batches reuse the
    // mount's definitions and the lookup table has to span both.
    let mut interns = interns_of(&mount);
    let new_todo = element_with_class(&mount, &interns, "new-todo").expect("the new-todo input");
    let _ = dom::take_effects();

    // Each keystroke is an `input` event carrying the control's value; the
    // app mirrors it into `new_todo_title`.
    deliver(new_todo, "input", form("milk"));
    if let Some(f) = take_frames() {
        interns.extend(interns_of(&f));
    }

    // Enter creates the todo, and the app cancels the default action.
    let verdict = Rc::new(Verdict::default());
    assert!(event::dispatch(
        new_todo,
        "keydown",
        keyboard("Enter"),
        verdict.clone()
    ));
    assert!(
        verdict.default_prevented(),
        "TodoMVC calls prevent_default on Enter"
    );
    wasm_bindgen_futures::run_pending();

    let frames = take_frames().expect("creating a todo mutates the DOM");
    interns.extend(interns_of(&frames));
    let created: Vec<u32> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::CreateElement(c)) => Some(c.tag),
            _ => None,
        })
        .collect();
    let li = *interns.get("li").expect("an <li> tag was interned");
    assert!(
        created.contains(&li),
        "the new todo's row was never created"
    );

    // Its title reaches the receiver as the text of a text node.
    let texts: Vec<&str> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::CreateText(t)) => Some(t.text.as_str()),
            Some(Op::SetText(t)) => Some(t.text.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        texts.contains(&"milk"),
        "the todo's title never went out; got {texts:?}"
    );

    // And the new-todo input is cleared through the `value` property.
    let value = *interns.get("value").expect("`value` was interned");
    assert!(
        frames.iter().any(|f| matches!(&f.op,
            Some(Op::SetProperty(p))
                if p.id == new_todo
                    && p.name == value
                    && p.value == Some(proto::set_property::Value::Text(String::new()))
        )),
        "the input should have been cleared"
    );
}

use std::rc::Rc;
use stream_dom_fakedom::event::{self, Verdict};

fn take_frames() -> Option<Vec<proto::Frame>> {
    let bytes = dom::take_batch()?;
    let mut buf = bytes.as_slice();
    let mut frames = Vec::new();
    while !buf.is_empty() {
        frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
    }
    Some(frames)
}

fn interns_of(frames: &[proto::Frame]) -> std::collections::HashMap<String, u32> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::Intern(i)) => Some((i.s.clone(), i.id)),
            _ => None,
        })
        .collect()
}

/// The node id of the first element the batch gave a `class` containing
/// `class`.
fn element_with_class(
    frames: &[proto::Frame],
    interns: &std::collections::HashMap<String, u32>,
    class: &str,
) -> Option<u32> {
    let slot = *interns.get("class")?;
    frames.iter().find_map(|f| match &f.op {
        Some(Op::SetAttribute(a)) if a.name == slot => a
            .value
            .as_deref()
            .filter(|v| v.split(' ').any(|t| t == class))
            .map(|_| a.id),
        _ => None,
    })
}

fn deliver(target: u32, name: &str, payload: proto::EventPayload) {
    assert!(event::dispatch(
        target,
        name,
        payload,
        Rc::new(Verdict::default())
    ));
    wasm_bindgen_futures::run_pending();
}

fn form(value: &str) -> proto::EventPayload {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Form(proto::FormData {
            value: value.to_string(),
            checked: None,
            fields: Vec::new(),
        })),
    }
}

fn keyboard(key: &str) -> proto::EventPayload {
    proto::EventPayload {
        family: Some(proto::event_payload::Family::Keyboard(
            proto::KeyboardData {
                key: key.to_string(),
                ..Default::default()
            },
        )),
    }
}
