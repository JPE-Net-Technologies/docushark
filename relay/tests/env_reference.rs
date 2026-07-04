//! Drift guard (JP-427): every `RELAY_*` environment variable the relay reads
//! at runtime must be documented in the README's environment-variable table.
//!
//! The relay silently ignores unknown env names, so an operator's typo no-ops
//! and an undocumented knob never reaches ops runbooks. This test extracts the
//! `"RELAY_…"` string literals from the source (the single place env names can
//! exist) and fails when one is missing from `relay/README.md`.
//!
//! Directionality: code → README is a hard failure (undocumented knob).
//! README → code is a warning only, so documentation can land ahead of (or
//! compose across) in-flight feature branches without breaking master.

use std::collections::BTreeSet;
use std::path::Path;

/// Extract `RELAY_[A-Z0-9_]+` tokens from `text`. When `quoted_only` is set,
/// only tokens wrapped in double quotes count (string literals in Rust source,
/// not prose or comments); otherwise any token counts (README backtick usage).
fn extract_env_names(text: &str, quoted_only: bool) -> BTreeSet<String> {
    let bytes = text.as_bytes();
    let mut out = BTreeSet::new();
    let mut i = 0;
    while let Some(pos) = text[i..].find("RELAY_") {
        let start = i + pos;
        let mut end = start + "RELAY_".len();
        while end < bytes.len() && (bytes[end].is_ascii_uppercase() || bytes[end].is_ascii_digit() || bytes[end] == b'_') {
            end += 1;
        }
        let name = &text[start..end];
        // A bare "RELAY_" prefix (e.g. the README's `RELAY_*` wildcard) or a
        // trailing underscore isn't a variable name.
        let is_name = name.len() > "RELAY_".len() && !name.ends_with('_');
        let quoted = start > 0
            && bytes[start - 1] == b'"'
            && end < bytes.len()
            && bytes[end] == b'"';
        if is_name && (!quoted_only || quoted) {
            out.insert(name.to_string());
        }
        i = end;
    }
    out
}

/// Recursively collect quoted `RELAY_*` literals from every `.rs` file under `dir`.
fn collect_from_sources(dir: &Path, out: &mut BTreeSet<String>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}"));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_from_sources(&path, out);
        } else if path.extension().is_some_and(|x| x == "rs") {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {path:?}: {e}"));
            out.extend(extract_env_names(&text, true));
        }
    }
}

#[test]
fn every_relay_env_var_is_documented_in_the_readme() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));

    let mut code_names = BTreeSet::new();
    collect_from_sources(&manifest.join("src"), &mut code_names);
    // Test-only env gates (e.g. the env-gated live S3 tests) are not operator
    // surface — exclude by prefix. RELAY_GIT_SHA / RELAY_BUILD_TIME are
    // compile-time stamps injected by build.rs (`cargo:rustc-env`), not
    // runtime configuration an operator can set.
    code_names.retain(|n| !n.starts_with("RELAY_TEST_"));
    code_names.remove("RELAY_GIT_SHA");
    code_names.remove("RELAY_BUILD_TIME");

    let readme = std::fs::read_to_string(manifest.join("README.md")).expect("read README.md");
    let doc_names = extract_env_names(&readme, false);

    let undocumented: Vec<&String> = code_names.difference(&doc_names).collect();
    assert!(
        undocumented.is_empty(),
        "RELAY_* env vars read by the relay but missing from README.md's \
         'Environment variables' table: {undocumented:?}\n\
         Add a row per variable (name → toml key / effect) to relay/README.md."
    );

    // Reverse direction: a documented name the code no longer reads is doc
    // rot, but only a warning — docs may land ahead of an in-flight branch.
    let unknown: Vec<&String> = doc_names.difference(&code_names).collect();
    if !unknown.is_empty() {
        eprintln!(
            "warning: README.md documents RELAY_* names the code does not read \
             (stale doc rows or pending features): {unknown:?}"
        );
    }
}

#[test]
fn extractor_understands_quoting_and_wildcards() {
    let src = r#"get("RELAY_PORT") // mentions RELAY_IN_COMMENT and RELAY_*"#;
    let quoted = extract_env_names(src, false);
    assert!(quoted.contains("RELAY_PORT") && quoted.contains("RELAY_IN_COMMENT"));
    let strict = extract_env_names(src, true);
    assert!(strict.contains("RELAY_PORT"));
    assert!(!strict.contains("RELAY_IN_COMMENT"), "comments must not count as code reads");
    assert!(!strict.iter().any(|n| n == "RELAY_"), "wildcard prefix is not a name");
}
