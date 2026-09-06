fn main() {
    // Autogenerates `allow-<command>`/`deny-<command>` permissions for the
    // five app commands (tauri-build acl.rs `AppManifest::commands`) so
    // `capabilities/default.json` can name them explicitly instead of
    // relying on an implicit "app commands are always allowed" default,
    // which Tauri 2 does not actually have.
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "spawn_producer",
            "read_chunk",
            "send_event",
            "answer_query",
            "kill_producer",
        ]));
    tauri_build::try_build(attributes).expect("tauri_build::try_build failed");
}
