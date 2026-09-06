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
                // The shim always states the parent, anchor or not.
                let parent = i.parent.expect("the shim always names a parent");
                assert!(created.contains(&parent) && created.contains(&i.id));
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
        Target::Node(new_todo),
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
use stream_dom_fakedom::event::{self, Target, Verdict};

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
        Target::Node(target),
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

/// The round trip the global-listener change exists for: the browser
/// changes the hash, the receiver reports `hashchange` on `window`, and
/// the app's filter follows. In the first spike this could not be
/// expressed at all — `window` had no addressable target, so the port had
/// to cancel the link click and set the route by hand.
#[test]
fn a_hashchange_on_window_moves_the_selected_filter() {
    let mount = mount_and_take_frames();
    let interns = interns_of(&mount);
    let class_slot = *interns.get("class").expect("`class` was interned");

    // The three filter links are the only elements carrying `selected`
    // signals; at mount, "All" is selected and the others are not.
    let selected_at_mount = selected_ids(&mount, class_slot);
    assert_eq!(
        selected_at_mount.len(),
        1,
        "exactly one filter starts selected; got {selected_at_mount:?}"
    );
    let all_link = selected_at_mount[0];

    // The links carry no click handlers now: the browser owns the hash.
    assert!(
        !mount.iter().any(|f| matches!(&f.op,
            Some(Op::AddListener(l))
                if l.listener.as_ref().and_then(|l| l.target)
                    == Some(proto::listener::Target::Id(all_link))
        )),
        "the filter links should have no listeners of their own"
    );

    // ... and the app registered its `hashchange` on the window global.
    assert!(
        mount.iter().any(|f| matches!(&f.op,
            Some(Op::AddListener(l)) if l.listener.as_ref().is_some_and(|l| {
                l.target == Some(proto::listener::Target::Global(proto::Global::Window as i32))
                    && interns.get("hashchange") == Some(&l.name)
            })
        )),
        "no window `hashchange` listener was registered"
    );

    assert!(event::dispatch(
        Target::Window,
        "hashchange",
        proto::EventPayload {
            family: Some(proto::event_payload::Family::Navigation(
                proto::NavigationData {
                    href: "http://localhost/#/completed".to_string(),
                },
            )),
        },
        Rc::new(Verdict::default()),
    ));
    wasm_bindgen_futures::run_pending();

    let after = take_frames().expect("the route change mutates the DOM");
    let now_selected = selected_ids(&after, class_slot);
    assert_eq!(
        now_selected.len(),
        1,
        "exactly one filter ends selected; got {now_selected:?}"
    );
    assert_ne!(
        now_selected[0], all_link,
        "the selection should have moved off `All`"
    );
    // And `All` was explicitly deselected rather than just left behind.
    assert!(
        after.iter().any(|f| matches!(&f.op,
            Some(Op::SetAttribute(a))
                if a.id == all_link
                    && a.name == class_slot
                    && !a.value.as_deref().unwrap_or("").split(' ').any(|t| t == "selected")
        )),
        "`All` should have had `selected` removed"
    );
}

/// Node ids whose last `class` write in this batch contains `selected`.
fn selected_ids(frames: &[proto::Frame], class_slot: u32) -> Vec<u32> {
    let mut state: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    for f in frames {
        if let Some(Op::SetAttribute(a)) = &f.op {
            if a.name == class_slot {
                let on = a
                    .value
                    .as_deref()
                    .unwrap_or("")
                    .split(' ')
                    .any(|t| t == "selected");
                state.insert(a.id, on);
            }
        }
    }
    let mut out: Vec<u32> = state
        .into_iter()
        .filter(|(_, on)| *on)
        .map(|(id, _)| id)
        .collect();
    out.sort_unstable();
    out
}
