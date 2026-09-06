//! Generated prost types for `polymorph:stream-dom`'s wire schema.
//!
//! Types are re-exported at crate root from the generated
//! `polymorph.stream_dom` module (see build.rs) so callers write
//! `stream_dom_proto::Frame`, not a package-qualified path.
//!
//! Normative source: `proto/stream-dom.proto` (mutation frames) and
//! `proto/stream-dom-events.proto` (event payloads). See docs/design.md
//! "Encoding" for why protobuf over a hand-rolled layout.

#![allow(clippy::doc_markdown)]

include!(concat!(env!("OUT_DIR"), "/polymorph.stream_dom.rs"));
