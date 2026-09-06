# polymorph:stream-dom — build/test entry points. Recipe bodies are the
# exact commands CI runs.

default: check test

# Type-check and lint every workspace (Rust: both cargo workspaces, for the
# component target; TS: receiver + web).
check:
    cargo clippy --workspace --target wasm32-wasip2 -- -D warnings
    cargo clippy --manifest-path guests/web-sys/Cargo.toml --workspace --target wasm32-wasip2 -- -D warnings
    deno task check

# Native unit tests (encoder, transcoder fixtures) + receiver tests.
test:
    cargo test --workspace --exclude dioxus-todomvc
    cargo test --manifest-path guests/web-sys/Cargo.toml --workspace
    deno task test

# Build both demo components into build/ and translate them at build time
# (the demos ship no translator).
components: (component "dioxus-todomvc" "Cargo.toml" "dioxus_todomvc") (component "dominator-todomvc" "guests/web-sys/Cargo.toml" "dominator_todomvc")

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
