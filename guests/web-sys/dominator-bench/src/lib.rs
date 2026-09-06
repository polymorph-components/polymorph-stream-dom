//! A js-framework-benchmark-shaped row table, as a `polymorph:stream-dom`
//! producer, for measuring row-operation throughput on the wire.
//!
//! Twin of `guests/dioxus/bench`. The two implement the same markup
//! contract and the same click behaviour so the frame streams they emit
//! for one click sequence are directly comparable; read that file's module
//! doc for the reasoning behind the contract, the fixed-seed labels and
//! the two sentinel counters, none of which is repeated here. What follows
//! is only what is specific to the Dominator side.
//!
//! Control surface, by element id: `create-1k`, `create-10k`, `append-1k`,
//! `update-every-10th`, `swap-rows`, `clear`, plus per-row `a` (select)
//! and `button.remove` (remove), reached through `tr[data-id="<id>"]`.
//!
//! # Cross-producer determinism
//!
//! [`Rng`], [`LABEL_SEED`], the three word lists and the draw order are
//! copied verbatim from the Dioxus twin. They are a contract, not an
//! implementation detail: the Nth label of a given click sequence must be
//! identical on both producers or the two frame streams are not
//! comparable. The check is the first three labels after a fresh mount —
//! `odd green table`, `inexpensive white table`, `adorable orange
//! keyboard` — asserted in `tests/mount.rs`.
//!
//! # Where the shapes differ from the Dioxus twin, and why
//!
//! Dioxus is a VDOM: state lives in signals, a click rerenders, and the
//! reconciler works out the mutations. Dominator is fine-grained: the
//! *state itself* is the reactive graph, so the same behaviour is
//! expressed differently and the wire cost differs in ways the benchmark
//! is there to measure.
//!
//! - **Row labels are `Mutable<String>` per row**, not a plain `String` in
//!   a `Vec` behind one signal. `update-every-10th` therefore writes each
//!   affected row's own signal and emits one `set-text` per changed row,
//!   with no list diff at all. The Dioxus twin rewrites the whole vector
//!   and lets the reconciler find the changes. Same frames at the end,
//!   arrived at from opposite directions — which is the comparison.
//! - **Selection is one `Mutable<Option<u32>>` read by a per-row
//!   `class_signal`.** Dominator's `set_class_signal` holds an `is_set`
//!   latch (dominator-0.5.38/src/dom.rs:1385), so an unselected row emits
//!   no `class` write at all rather than `class=""` — which is what the
//!   contract asks for, and it falls out rather than being arranged.
//! - **`swap-rows` costs two moves, not one.** `MutableVecLockMut::swap`
//!   exists but is implemented as two `move_from_to` calls
//!   (futures-signals-0.3.34/src/signal_vec.rs:3237), so it emits two
//!   `VecDiff::Move`s and dominator turns those into two `insert-before`
//!   frames. That is a real framework-level cost and the benchmark should
//!   see it, so this calls `swap` rather than hand-rolling something
//!   cheaper.
//!
//! The per-row remove button carries no `id="remove-{id}"`, for the same
//! reason as the twin: a dynamic id per row is a `set-attribute` frame per
//! row, i.e. pure measurement noise, when `tr[data-id]` already addresses
//! the row.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use dominator::{clone, events, html, Dom};
use futures_signals::signal::{Mutable, SignalExt};
use futures_signals::signal_vec::{MutableVec, SignalVecExt};

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

/// splitmix64, copied verbatim from the Dioxus twin — algorithm,
/// constants and draw order alike. Not the `rand` crate: this builds as a
/// wasm component, and OS entropy is exactly what must not be here.
///
/// Persistent across calls, never reseeded mid-session, so two `create-1k`
/// clicks produce different labels (real work for the receiver on every
/// rep) while a fresh mount always restarts at [`LABEL_SEED`].
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

/// One row. The label is a `Mutable` so `update-every-10th` can write a
/// single row without touching the list — see the module doc.
///
/// Handles are `Rc`, not the `Arc` a Dominator app conventionally uses: a
/// component is single-threaded, the state here is `Cell`/`RefCell`, and
/// an `Arc` around non-`Sync` contents is a lie clippy is right to reject.
pub struct Row {
    id: u32,
    label: Mutable<String>,
}

pub struct App {
    rows: MutableVec<Rc<Row>>,
    /// Monotonic from 1, never reset within a mount: a "create" must hand
    /// the receiver genuinely new ids, or it degrades to an in-place
    /// update and measures the wrong thing.
    next_id: Cell<u32>,
    label_rng: RefCell<Rng>,
    update_runs: Mutable<u32>,
    selected: Mutable<Option<u32>>,
}

impl App {
    pub fn new() -> Rc<Self> {
        Rc::new(App {
            rows: MutableVec::new(),
            next_id: Cell::new(1),
            label_rng: RefCell::new(Rng::new(LABEL_SEED)),
            update_runs: Mutable::new(0),
            selected: Mutable::new(None),
        })
    }

    fn build_label(&self) -> String {
        let rng = &mut *self.label_rng.borrow_mut();
        let a = ADJECTIVES[rng.index(ADJECTIVES.len())];
        let c = COLOURS[rng.index(COLOURS.len())];
        let n = NOUNS[rng.index(NOUNS.len())];
        format!("{a} {c} {n}")
    }

    fn build_rows(&self, count: usize) -> Vec<Rc<Row>> {
        (0..count)
            .map(|_| {
                let id = self.next_id.get();
                self.next_id.set(id + 1);
                Rc::new(Row {
                    id,
                    label: Mutable::new(self.build_label()),
                })
            })
            .collect()
    }

    fn create(&self, count: usize) {
        let rows = self.build_rows(count);
        self.rows.lock_mut().replace_cloned(rows);
    }

    fn append(&self, count: usize) {
        let rows = self.build_rows(count);
        self.rows.lock_mut().extend(rows);
    }

    fn update_every_10th(&self) {
        // One write per affected row's own signal: no list diff, so the
        // wire sees `set-text` and nothing else.
        for row in self.rows.lock_ref().iter().step_by(10) {
            let mut label = row.label.lock_mut();
            label.push_str(" !!!");
        }
        self.update_runs.replace_with(|n| *n + 1);
    }

    fn swap_rows(&self) {
        let mut rows = self.rows.lock_mut();
        if rows.len() > 998 {
            // Two `move_from_to`s underneath; see the module doc.
            rows.swap(1, 998);
        }
    }

    fn clear(&self) {
        self.rows.lock_mut().clear();
    }

    fn remove(&self, id: u32) {
        self.rows.lock_mut().retain(|row| row.id != id);
    }

    fn control(app: &Rc<Self>, id: &str, text: &str, f: impl Fn(&App) + 'static) -> Dom {
        html!("button", {
            .attr("id", id)
            .text(text)
            .event(clone!(app => move |_: events::Click| f(&app)))
        })
    }

    fn render_row(app: Rc<Self>, row: Rc<Row>) -> Dom {
        let id = row.id;
        html!("tr", {
            .attr("data-id", &id.to_string())
            // No `class` write at all while unselected: dominator's
            // `is_set` latch suppresses the initial `false`.
            .class_signal("selected", app.selected.signal_ref(move |s| *s == Some(id)).dedupe())
            .children(&mut [
                html!("td", {
                    .class("id")
                    .text(&id.to_string())
                }),
                html!("td", {
                    .class("label")
                    .children(&mut [
                        html!("a", {
                            .text_signal(row.label.signal_cloned())
                            .event(clone!(app => move |_: events::Click| {
                                app.selected.set_neq(Some(id));
                            }))
                        }),
                    ])
                }),
                html!("td", {
                    .class("remove")
                    .children(&mut [
                        html!("button", {
                            .class("remove")
                            .text("x")
                            .event(clone!(app => move |_: events::Click| app.remove(id)))
                        }),
                    ])
                }),
            ])
        })
    }

    pub fn render(app: Rc<Self>) -> Dom {
        html!("div", {
            .attr("id", "bench")
            .children(&mut [
                html!("div", {
                    .class("controls")
                    .children(&mut [
                        Self::control(&app, "create-1k", "Create 1,000 rows", |a| a.create(1_000)),
                        Self::control(&app, "create-10k", "Create 10,000 rows", |a| a.create(10_000)),
                        Self::control(&app, "append-1k", "Append 1,000 rows", |a| a.append(1_000)),
                        Self::control(&app, "update-every-10th", "Update every 10th row", App::update_every_10th),
                        Self::control(&app, "swap-rows", "Swap rows", App::swap_rows),
                        Self::control(&app, "clear", "Clear", App::clear),
                    ])
                }),

                // Completion sentinels for the benchmark driver; the twin's
                // module doc records the run that measured nothing without
                // them.
                html!("span", {
                    .attr("id", "row-count")
                    .text_signal(app.rows.signal_vec_cloned().len().map(|n| n.to_string()))
                }),
                html!("span", {
                    .attr("id", "update-run-count")
                    .text_signal(app.update_runs.signal().map(|n| n.to_string()))
                }),

                html!("table", {
                    .class("table")
                    .children(&mut [
                        html!("tbody", {
                            .attr("id", "rows")
                            .children_signal_vec(app.rows.signal_vec_cloned()
                                .map(clone!(app => move |row| App::render_row(app.clone(), row))))
                        }),
                    ])
                }),
            ])
        })
    }
}

stream_dom_fakedom::launch!(mount);

fn mount() {
    dominator::append_dom(&dominator::body(), App::render(App::new()));
}
