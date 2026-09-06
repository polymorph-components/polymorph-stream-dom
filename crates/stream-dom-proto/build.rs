//! Compiles proto/stream-dom.proto and proto/stream-dom-events.proto with
//! protox (a pure-Rust protoc replacement, so no system protoc is needed —
//! required for a clean wasm32-wasip2 build environment) and prost-build.

fn main() {
    let proto_dir = "../../proto";
    let files = ["stream-dom.proto", "stream-dom-events.proto"];

    println!("cargo:rerun-if-changed={proto_dir}/stream-dom.proto");
    println!("cargo:rerun-if-changed={proto_dir}/stream-dom-events.proto");

    let file_descriptor_set = protox::compile(files, [proto_dir]).expect("protox: compile failed");

    prost_build::Config::new()
        .compile_fds(file_descriptor_set)
        .expect("prost-build: compile failed");
}
