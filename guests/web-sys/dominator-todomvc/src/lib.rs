//! Dominator's TodoMVC, running as a `polymorph:stream-dom` producer.
//!
//! The application code is Dominator's own example
//! (rust-dominator/examples/todomvc). Three things changed, and nothing
//! else:
//!
//! 1. **No persistence.** `App::deserialize` is `App::new` and `serialize`
//!    is a no-op: `localStorage` is the host page's, and the protocol has
//!    no op for it. `serde` goes with it.
//! 2. **No URL routing.** `Route` is a plain `Mutable<Route>` the filter
//!    links set directly, instead of being derived from
//!    `dominator::routing::url()`. A producer has no `Location` and no
//!    `History` (see `stream_dom_fakedom::protocol`, which refuses both);
//!    routing belongs to whatever owns the address bar, which is the
//!    receiver.
//! 3. **Mount.** `dominator::append_dom` onto the protocol's mount root
//!    (node id 0) instead of `dominator::get_id("app")`. That is spelled
//!    with dominator's own `body()`, because the fake `document.body` *is*
//!    the mount root -- the receiver owns everything above it.
//!
//! Everything else -- the markup, the class names, the signals, the event
//! handlers, `focused_signal`, `visible_signal` -- is unmodified, which is
//! the point: the framework never learns it is not talking to a browser.

// The application code below is Dominator's example, kept verbatim apart
// from the three changes above -- that it is unmodified is the property
// this spike is testing. These are the lints the upstream example trips;
// silencing them here beats editing the app and blurring the diff.
#![allow(
    clippy::arc_with_non_send_sync,
    clippy::bool_comparison,
    clippy::derivable_impls,
    clippy::needless_borrow,
    clippy::redundant_field_names,
    clippy::wrong_self_convention
)]

pub mod app;
mod todo;
mod util;

pub use app::App;

stream_dom_fakedom::launch!(mount);

fn mount() {
    dominator::append_dom(&dominator::body(), App::render(App::new()));
}
