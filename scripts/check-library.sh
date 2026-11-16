#!/usr/bin/env bash
# Run the actual SQLite library tests without linking a desktop webview.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
check_dir="${EARBUD_LIBRARY_CHECK_DIR:-/tmp/earbud-library-checks}"
mkdir -p "$check_dir/src"
cat > "$check_dir/Cargo.toml" <<'TOML'
[package]
name = "earbud-library-checks"
version = "0.1.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.41", features = ["bundled"] }
uuid = { version = "1", features = ["v4"] }
thiserror = "2"
sha2 = "0.10"
[dev-dependencies]
tempfile = "3"
TOML
# JSON escaping also produces valid Rust string literals for these paths.
python3 - "$repo_dir" "$check_dir" <<'PY'
import json, pathlib, sys
repo, check = map(pathlib.Path, sys.argv[1:])
source = '''pub mod error {
    pub type Result<T> = std::result::Result<T, Error>;
    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error("{0}")] Invalid(String),
        #[error("not found: {0}")] NotFound(String),
        #[error(transparent)] Io(#[from] std::io::Error),
        #[error(transparent)] Database(#[from] rusqlite::Error),
        #[error(transparent)] Json(#[from] serde_json::Error),
    }
}
'''
source += '#[path=' + json.dumps(str(repo / 'src-tauri/src/library/mod.rs')) + ']\npub mod library;\n'
(check / 'src/lib.rs').write_text(source)
PY
cargo test --manifest-path "$check_dir/Cargo.toml" "$@"
