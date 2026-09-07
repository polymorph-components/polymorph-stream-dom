# polymorph:stream-dom — build/test entry points. Recipe bodies are the
# exact commands CI runs.

default: check test

# Type-check and lint every workspace (Rust: the two component workspaces
# for the wasm target, the native host workspace; TS: receiver + web +
# desktop UI). Depends on desktop-ui because tauri's generate_context!
# refuses to compile without the frontendDist directory present.
check: desktop-ui proto-drift
    cargo clippy --workspace --target wasm32-wasip2 -- -D warnings
    cargo clippy --manifest-path guests/web-sys/Cargo.toml --workspace --target wasm32-wasip2 -- -D warnings
    cargo clippy --manifest-path host/Cargo.toml --workspace -- -D warnings
    deno task check

# Regenerate the receiver's protobuf readers/writers from proto/ into
# receiver/src/gen/. `buf` runs from npm under Deno and spawns the ts-proto
# plugin through `deno run`, so this needs no Node and no protoc.
proto-ts:
    deno run -A npm:@bufbuild/buf@1.72.0 generate

# Drift gate for the committed generated code: regenerate into a temp dir
# and compare. `buf generate -o <dir>` reproduces the plugin's `out` path
# under it, so the comparison is <tmp>/receiver/src/gen vs receiver/src/gen.
proto-drift:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    deno run -A npm:@bufbuild/buf@1.72.0 generate --template buf.gen.yaml -o "$tmp"
    if ! diff -r "$tmp/receiver/src/gen" receiver/src/gen; then
        echo "receiver/src/gen is out of date with proto/ — run \`just proto-ts\`" >&2
        exit 1
    fi

# Native unit tests (encoder, transcoder fixtures) + receiver tests + the
# wasmtime host, whose integration test runs the TodoMVC component.
test: host-component
    cargo test --workspace --exclude dioxus-todomvc
    cargo test --manifest-path guests/web-sys/Cargo.toml --workspace
    cargo test --manifest-path host/Cargo.toml --workspace
    deno task test

# The one component `just test` needs. Same build as the `component` recipe
# without the translation step, which needs deno and the network.
host-component:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p build
    cargo build -p dioxus-todomvc --target wasm32-wasip2 --release
    cp target/wasm32-wasip2/release/dioxus_todomvc.wasm build/dioxus-todomvc.component.wasm
    wasm-tools validate --features component-model,cm-async build/dioxus-todomvc.component.wasm

# Build all demo + bench components into build/ and translate them at
# build time (the demos ship no translator).
components: (component "dioxus-todomvc" "Cargo.toml" "dioxus_todomvc") (component "dominator-todomvc" "guests/web-sys/Cargo.toml" "dominator_todomvc") (component "dioxus-bench" "Cargo.toml" "dioxus_bench") (component "dominator-bench" "guests/web-sys/Cargo.toml" "dominator_bench")

component name manifest artifact:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p build
    cargo build -p {{name}} --manifest-path {{manifest}} --target wasm32-wasip2 --release
    dir=$(dirname {{manifest}})
    cp "$dir/target/wasm32-wasip2/release/{{artifact}}.wasm" build/{{name}}.component.wasm
    wasm-tools validate --features component-model,cm-async build/{{name}}.component.wasm
    deno run --allow-read --allow-write --allow-env --allow-net web/translate.ts build/{{name}}.component.wasm

# Assemble the GitHub Pages site into dist/ (bundled receiver + demo pages +
# components + envelopes). Requires `just components`.
site:
    deno run --allow-read --allow-write --allow-env --allow-net --allow-run web/build.ts

# Playwright end-to-end run against dist/. Chromium is installed with
# Node's npx: `deno run npm:playwright install` hangs after the download
# (reproduced locally and in CI), npx completes.
e2e: site
    npx -y playwright@1.58 install chromium
    deno test -A web/e2e/

# Wire-shape regression gate for the bench producers: compares each
# producer/op's frame/byte/batch counts (native receiver, direct
# transport) against bench/wire-baseline.json.
bench-wire: site
    npx -y playwright@1.58 install chromium
    deno run -A bench/wire.ts

# Runs the tachometer benchmark matrix against dist/ and writes
# bench/results/{tachometer,benchmark}.json.
bench: site
    npx -y playwright@1.58 install chromium
    deno run -A bench/run.ts

# Bundle the desktop app's frontend (host/desktop/dist/).
desktop-ui:
    deno run -A host/desktop/build.ts

# Build the Tauri desktop app: the TodoMVC component it embeds, its
# frontend bundle, then the Rust binary. The app is never bundled, so the
# component is copied beside the binary by hand: `resource_dir()` is the
# binary's own directory for an unbundled build, and a `bundle.resources`
# entry in tauri.conf.json would make tauri-build fail whenever the
# component has not been built yet (`just check` runs before it has).
desktop: host-component desktop-ui
    cargo build --manifest-path host/Cargo.toml -p stream-dom-desktop --release
    mkdir -p host/target/release/components
    cp build/dioxus-todomvc.component.wasm host/target/release/components/

# WebDriver smoke test against the built app (host/desktop/e2e/smoke.ts).
# No display on this machine: everything GUI runs under `xvfb-run -a`.
# Named explicitly, not `host/desktop/e2e/`: `deno test` only autodiscovers
# `*_test.ts`/`*.test.ts`, and `smoke.ts` (not `smoke_test.ts`) is the name
# this track's dispatch specified.
desktop-smoke: desktop
    xvfb-run -a deno test -A host/desktop/e2e/smoke.ts
