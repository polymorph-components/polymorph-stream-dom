//! A js-framework-benchmark-shaped row table, as a `polymorph:stream-dom`
//! producer, for measuring row-operation throughput on the wire.
//!
//! Ported from polyengine-dioxus's `examples/bench-rows/src/lib.rs` (same
//! author, Apache-2.0). The markup is *not* that file's: it follows this
//! repo's shared bench contract instead, so the Dominator twin emits a
//! comparable frame stream for the same click sequence. Differences from the
//! port are listed at the end of this comment.
//!
//! Control surface, by element id: `create-1k`, `create-10k`, `append-1k`,
//! `update-every-10th`, `swap-rows`, `clear`, plus per-row `a` (select) and
//! `button.remove` (remove), reached through `tr[data-id="<id>"]`.
//!
//! # Fixed-seed labels, seeded once per mount
//!
//! Labels use js-framework-benchmark's word lists (adjective + colour +
//! noun) but draw from a fixed-seed PRNG rather than `Math.random()` or
//! `rand`-with-OS-entropy: reproducibility beats realism for a benchmark.
//! The generator is seeded once at mount and **never reseeded** — see
//! [`Rng`]. Repeated `create-1k` clicks therefore produce *different* labels
//! (real diff work for the keyed reconciler on every rep) while the Nth
//! label across any fixed click sequence is identical on every run and, more
//! to the point, identical between this producer and the Dominator one. The
//! workload's shape and sequence are reproducible, not its literal
//! per-click byte content.
//!
//! The first label of the first `create-1k` after a fresh mount is
//! `odd green table`; the next two are `inexpensive white table` and
//! `adorable orange keyboard`. That triple is the cross-producer
//! determinism check.
//!
//! # Why the two sentinel counters exist
//!
//! `#row-count` and `#update-run-count` are read by the benchmark driver to
//! decide when an operation has finished. They are not decoration and they
//! are not redundant with counting `tbody` children. polyengine-dioxus
//! records the failure that motivated them: an earlier revision reseeded the
//! PRNG per call, so repeated `create-Nk` clicks produced byte-identical
//! label sets, and a driver whose completion predicate only checked row
//! *count* saw nothing change once warmup had already reached that count —
//! those repetitions measured nothing at all. The fix was on both sides: the
//! persistent-RNG discipline above, so content really changes, plus a driver
//! predicate that asserts a sentinel moved rather than merely counting rows.
//! `#update-run-count` is that sentinel for `update-every-10th`, whose row
//! count does not change at all.
//!
//! # Deliberate divergences from the polyengine-dioxus port
//!
//! - Markup follows the shared contract: `div#bench` (not `div.bench-rows`),
//!   `table.table`, `td.id` / `td.label` / `td.remove`, and the label lives
//!   in an `a` inside `td.label` because clicking it selects the row.
//! - Row selection is new here (no counterpart in the port): a single
//!   `Signal<Option<u32>>`, rendered as `class="selected"` on the one
//!   selected `tr` and *no* `class` attribute on every other row.
//! - The per-row remove button has no `id="remove-{id}"`. The contract does
//!   not ask for one, and a dynamic `id` per row is a `set-attribute` frame
//!   per row on the wire — pure measurement noise when `tr[data-id]` already
//!   addresses the row.

use dioxus::prelude::*;
use stream_dom_dioxus::launch;

const ADJECTIVES: &[&str] = &[
    "pretty",
    "large",
    "big",
    "small",
    "tall",
    "short",
    "long",
    "handsome",
    "plain",
    "quaint",
    "clean",
    "elegant",
    "easy",
    "angry",
    "crazy",
    "helpful",
    "mushy",
    "odd",
    "unsightly",
    "adorable",
    "important",
    "inexpensive",
    "cheap",
    "expensive",
    "fancy",
];
// "brown" really does appear twice; this is js-framework-benchmark's list
// verbatim, and changing it would change every drawn colour.
const COLOURS: &[&str] = &[
    "red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black",
    "orange",
];
const NOUNS: &[&str] = &[
    "table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger",
    "pizza", "mouse", "keyboard",
];

/// splitmix64, *not* the `rand` crate: this builds as a wasm component, and
/// a real PRNG crate plus its OS-entropy backend is unnecessary weight for a
/// fixed-seed generator — and OS entropy is exactly what must not be here.
///
/// **Persistent across calls, never reseeded mid-session.** The app holds one
/// `Rng` in a signal for its whole lifetime. Every `build_rows` call advances
/// it, so two `create-1k` clicks in a row produce different labels; a fresh
/// mount always restarts at [`LABEL_SEED`], so the Nth label in a given click
/// sequence is fixed. The algorithm, the constants and the draw order
/// (adjective, then colour, then noun, each `next_u64() % len`) are part of
/// the cross-producer contract: the Dominator twin reproduces them exactly,
/// and any change here desynchronizes the two label streams.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn index(&mut self, len: usize) -> usize {
        (self.next_u64() % len as u64) as usize
    }
}

/// Seeded once per mount. See [`Rng`].
const LABEL_SEED: u64 = 0x00C0_FFEE_1234_5678;

#[derive(Clone, PartialEq)]
struct Row {
    id: u32,
    label: String,
}

fn build_label(rng: &mut Rng) -> String {
    let a = ADJECTIVES[rng.index(ADJECTIVES.len())];
    let c = COLOURS[rng.index(COLOURS.len())];
    let n = NOUNS[rng.index(NOUNS.len())];
    format!("{a} {c} {n}")
}

fn build_rows(count: usize, rng: &mut Rng, next_id: &mut u32) -> Vec<Row> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let id = *next_id;
        *next_id += 1;
        out.push(Row {
            id,
            label: build_label(rng),
        });
    }
    out
}

#[allow(non_snake_case)]
fn App() -> Element {
    let mut rows = use_signal(Vec::<Row>::new);
    // Monotonic from 1, never reset within a mount: the keyed reconciler must
    // see genuinely new keys on every create, or a "create" degrades to an
    // in-place update and measures the wrong thing.
    let mut next_id = use_signal(|| 1u32);
    let mut label_rng = use_signal(|| Rng::new(LABEL_SEED));
    let mut update_runs = use_signal(|| 0u32);
    let mut selected = use_signal(|| None::<u32>);

    rsx! {
        div { id: "bench",
            div { class: "controls",
                button {
                    id: "create-1k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let data = build_rows(1_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.set(data);
                    },
                    "Create 1,000 rows"
                }
                button {
                    id: "create-10k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let data = build_rows(10_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.set(data);
                    },
                    "Create 10,000 rows"
                }
                button {
                    id: "append-1k",
                    onclick: move |_| {
                        let mut id = next_id();
                        let mut data = build_rows(1_000, &mut label_rng.write(), &mut id);
                        next_id.set(id);
                        rows.write().append(&mut data);
                    },
                    "Append 1,000 rows"
                }
                button {
                    id: "update-every-10th",
                    onclick: move |_| {
                        rows.write().iter_mut().step_by(10).for_each(|r| r.label.push_str(" !!!"));
                        update_runs += 1;
                    },
                    "Update every 10th row"
                }
                button {
                    id: "swap-rows",
                    onclick: move |_| {
                        let mut w = rows.write();
                        if w.len() > 998 {
                            w.swap(1, 998);
                        }
                    },
                    "Swap rows"
                }
                button {
                    id: "clear",
                    onclick: move |_| rows.set(Vec::new()),
                    "Clear"
                }
            }
            // Completion sentinels for the benchmark driver; see the module
            // doc on why counting `tbody` children is not enough.
            span { id: "row-count", "{rows.read().len()}" }
            span { id: "update-run-count", "{update_runs}" }
            table { class: "table",
                tbody { id: "rows",
                    for row in rows.read().iter().cloned() {
                        tr {
                            key: "{row.id}",
                            "data-id": "{row.id}",
                            // Absent, not empty, on unselected rows: a
                            // `class` hole with no value is an attribute
                            // *removal* on the wire.
                            class: if selected() == Some(row.id) { "selected" },
                            td { class: "id", "{row.id}" }
                            td { class: "label",
                                a {
                                    onclick: move |_| selected.set(Some(row.id)),
                                    "{row.label}"
                                }
                            }
                            td { class: "remove",
                                button {
                                    class: "remove",
                                    onclick: move |_| rows.write().retain(|r| r.id != row.id),
                                    "x"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

launch!(App);
