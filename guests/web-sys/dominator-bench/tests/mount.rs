//! Does the benchmark app actually run, and does it agree with its twin?
//!
//! One click of `#create-1k`, checked two ways: the frame stream has the
//! shape the shared bench contract calls for, and the labels are the ones
//! `guests/dioxus/bench` produces for the same click. The second is the
//! point — if the two producers' PRNGs drift apart, their wire metrics stop
//! being comparable and nothing else in the harness would notice.
//!
//! Native only, on the small executor in the `wasm-bindgen-futures` shim.

use std::collections::HashMap;
use std::rc::Rc;

use dominator_bench::App;
use prost::Message;
use stream_dom_fakedom::dom;
use stream_dom_fakedom::event::{self, Target, Verdict};
use stream_dom_guest::proto::{self, frame::Op};

fn text_value(a: &proto::SetAttribute) -> Option<&str> {
    match &a.value {
        Some(proto::set_attribute::Value::Text(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn decode(bytes: &[u8]) -> Vec<proto::Frame> {
    let mut buf = bytes;
    let mut frames = Vec::new();
    while !buf.is_empty() {
        frames.push(proto::Frame::decode_length_delimited(&mut buf).unwrap());
    }
    frames
}

fn take_frames() -> Option<Vec<proto::Frame>> {
    Some(decode(&dom::take_batch()?))
}

fn interns_of(frames: &[proto::Frame]) -> HashMap<String, u32> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::Intern(i)) => Some((i.s.clone(), i.id)),
            _ => None,
        })
        .collect()
}

/// The node whose `id` attribute was set to `id` in this batch.
fn element_with_id(
    frames: &[proto::Frame],
    interns: &HashMap<String, u32>,
    id: &str,
) -> Option<u32> {
    let slot = *interns.get("id")?;
    frames.iter().find_map(|f| match &f.op {
        Some(Op::SetAttribute(a)) if a.name == slot && text_value(a) == Some(id) => Some(a.id),
        _ => None,
    })
}

fn texts(frames: &[proto::Frame]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::CreateText(t)) => Some(t.text.as_str()),
            Some(Op::SetText(t)) => Some(t.text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn create_1k_emits_a_thousand_rows_with_the_shared_label_sequence() {
    stream_dom_fakedom::install();
    dominator::append_dom(&dominator::body(), App::render(App::new()));
    wasm_bindgen_futures::run_pending();

    let mount = take_frames().expect("the mount produced a batch");
    let mut interns = interns_of(&mount);

    // The control surface the benchmark driver clicks by id.
    for control in [
        "bench",
        "create-1k",
        "create-10k",
        "append-1k",
        "update-every-10th",
        "swap-rows",
        "clear",
        "row-count",
        "update-run-count",
        "rows",
    ] {
        assert!(
            element_with_id(&mount, &interns, control).is_some(),
            "no element with id {control:?} was created"
        );
    }
    let create_1k = element_with_id(&mount, &interns, "create-1k").unwrap();

    assert!(
        texts(&mount).contains(&"0"),
        "the row-count sentinel should start at 0; got {:?}",
        texts(&mount)
    );

    assert!(event::dispatch(
        Target::Node(create_1k),
        "click",
        proto::EventPayload {
            family: Some(proto::event_payload::Family::Mouse(
                proto::MouseData::default()
            )),
            text_control: None,
        },
        Rc::new(Verdict::default()),
    ));
    wasm_bindgen_futures::run_pending();

    let frames = take_frames().expect("create-1k mutates the DOM");
    interns.extend(interns_of(&frames));

    // One `<tr>` per row, and the row's three cells.
    let tag_counts = |tag: &str| {
        let slot = *interns
            .get(tag)
            .unwrap_or_else(|| panic!("<{tag}> was never interned"));
        frames
            .iter()
            .filter(|f| matches!(&f.op, Some(Op::CreateElement(c)) if c.tag == slot))
            .count()
    };
    assert_eq!(tag_counts("tr"), 1_000, "one <tr> per row");
    assert_eq!(tag_counts("td"), 3_000, "three cells per row");
    assert_eq!(tag_counts("a"), 1_000, "the label anchor per row");

    // Every row is attached, and the sentinel moved.
    let inserts = frames
        .iter()
        .filter(|f| matches!(&f.op, Some(Op::InsertBefore(_))))
        .count();
    assert!(
        inserts >= 1_000,
        "every row must be inserted; got {inserts} insert-before frames"
    );
    let texts = texts(&frames);
    assert!(
        texts.contains(&"1000"),
        "the row-count sentinel should reach 1000"
    );

    // The cross-producer determinism check: the same labels, in the same
    // row order, as `guests/dioxus/bench` emits for this click. A drift in
    // either PRNG shows up here and nowhere else.
    //
    // Correlated by node id, not by frame order. A label comes from
    // `text_signal`, so its text arrives from a spawned signal task, and
    // the order those tasks run in is the executor's business -- the
    // native one in the `wasm-bindgen-futures` shim drains its ready set
    // LIFO, so row 1000's label lands on the wire before row 1's. Node ids
    // *are* in creation order (they are allocated monotonically, see
    // `stream_dom_guest::Ids`), and rows are created in order, so sorting
    // this batch's `set-text` targets by id recovers row order.
    let created_here: std::collections::HashSet<u32> = frames
        .iter()
        .filter_map(|f| match &f.op {
            Some(Op::CreateText(t)) => Some(t.id),
            _ => None,
        })
        .collect();
    let mut labels: Vec<(u32, &str)> = frames
        .iter()
        .filter_map(|f| match &f.op {
            // Excludes the `#row-count` sentinel, whose text node was
            // created back at mount.
            Some(Op::SetText(t)) if created_here.contains(&t.id) => Some((t.id, t.text.as_str())),
            _ => None,
        })
        .collect();
    labels.sort_unstable_by_key(|(id, _)| *id);
    assert_eq!(labels.len(), 1_000, "one label per row");
    assert_eq!(
        labels.iter().map(|(_, t)| *t).take(3).collect::<Vec<_>>(),
        [
            "odd green table",
            "inexpensive white table",
            "adorable orange keyboard"
        ],
        "the label sequence must match guests/dioxus/bench exactly"
    );

    // Selection is absent, not empty, on an unselected row: dominator's
    // `is_set` latch means no `class` write happens at all for `selected`.
    let class = *interns.get("class").expect("`class` was interned");
    assert!(
        !frames.iter().any(|f| matches!(&f.op,
            Some(Op::SetAttribute(a))
                if a.name == class
                    && text_value(a).is_some_and(|v| v.split(' ').any(|t| t == "selected"))
        )),
        "no row should be selected after create-1k"
    );
}
