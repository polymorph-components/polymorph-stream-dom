//! `stream-dom-desktop`: a Tauri host embedding a single untrusted
//! `polymorph:stream-dom` producer (the TodoMVC demo) in a webview.
//!
//! Run: `just desktop` builds it; `cargo tauri dev --config
//! host/desktop/tauri.conf.json` (from repo root, with `just host-component`
//! already run) for a dev loop. No display here: everything GUI runs under
//! `xvfb-run -a`.

mod bridge;
mod commands;

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::Result;
use stream_dom_host::Host;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use commands::Producers;

/// Only these names may be requested by `spawn_producer` — the resource
/// path is built from it (`components/<name>.component.wasm`), so an
/// unconstrained name would be a path-traversal seam into the app's
/// resource directory.
pub(crate) fn valid_component_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Per-process wasmtime state: the engine/linker (`Host`) plus compiled
/// components, cached by name so a second `spawn_producer` for the same
/// name skips recompilation.
pub(crate) struct AppState {
    pub host: Host,
    pub components: Mutex<HashMap<String, stream_dom_host::Component>>,
    pub producers: Producers,
}

fn main() -> Result<()> {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            // `Host::new` spawns the epoch ticker as a tokio task, so it
            // must run where a runtime is current; `tauri::async_runtime`
            // is the tokio runtime tauri itself drives the event loop on.
            let host = tauri::async_runtime::block_on(async { Host::new(Default::default()) })?;
            app.manage(AppState {
                host,
                components: Mutex::new(HashMap::new()),
                producers: Producers::default(),
            });

            // Built here rather than via `tauri.conf.json`'s `app.windows`:
            // `on_navigation` has no config-file equivalent, and refusing
            // any navigation away from the app's own origin is what makes
            // `externalLinks: true` in the producer's policy safe — the
            // producer may *name* an `https://` link, but the host simply
            // never follows it.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("stream-dom-desktop")
                .on_navigation(|url| {
                    let same_origin = url.scheme() == "tauri"
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
                    if !same_origin {
                        log::warn!("refusing navigation to {url}");
                    }
                    same_origin
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_producer,
            commands::read_chunk,
            commands::send_event,
            commands::answer_query,
            commands::kill_producer,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
