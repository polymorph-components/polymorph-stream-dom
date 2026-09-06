//! Compiles proto/stream-dom.proto and proto/stream-dom-events.proto with
//! protox (a pure-Rust protoc replacement, so no system protoc is needed —
//! required for a clean wasm32-wasip2 build environment) and prost-build.
//!
//! Also extracts the `// PROTOCOL VERSION: <n>` line from
//! proto/stream-dom.proto (see that file's header) and emits it as
//! `PROTOCOL_VERSION` for lib.rs to `include!`.

use std::path::Path;

fn main() {
    let proto_dir = "../../proto";
    let files = ["stream-dom.proto", "stream-dom-events.proto"];

    println!("cargo:rerun-if-changed={proto_dir}/stream-dom.proto");
    println!("cargo:rerun-if-changed={proto_dir}/stream-dom-events.proto");

    let file_descriptor_set = protox::compile(files, [proto_dir]).expect("protox: compile failed");

    prost_build::Config::new()
        .compile_fds(file_descriptor_set)
        .expect("prost-build: compile failed");

    let stream_dom_proto =
        std::fs::read_to_string(format!("{proto_dir}/stream-dom.proto")).expect("read stream-dom.proto");
    let mut matches = stream_dom_proto
        .lines()
        .filter_map(|line| line.strip_prefix("// PROTOCOL VERSION: "));
    let version = matches
        .next()
        .unwrap_or_else(|| panic!("no `// PROTOCOL VERSION: <n>` line found in {proto_dir}/stream-dom.proto"));
    if matches.next().is_some() {
        panic!("more than one `// PROTOCOL VERSION: <n>` line found in {proto_dir}/stream-dom.proto");
    }
    let version: u32 = version
        .parse()
        .unwrap_or_else(|e| panic!("`// PROTOCOL VERSION: {version}` is not a valid u32: {e}"));

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    std::fs::write(
        Path::new(&out_dir).join("protocol_version.rs"),
        format!(
            "/// Mirrors the `// PROTOCOL VERSION: <n>` line in proto/stream-dom.proto.\npub const PROTOCOL_VERSION: u32 = {version};\n"
        ),
    )
    .expect("write protocol_version.rs");
}
