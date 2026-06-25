//! Agent guidance for the MCP surface (JP-328, Pillar 3).
//!
//! Powers the `docushark_get_skills` tool. Agents that don't already know the
//! DocuShark recipes tend to fire malformed tool calls — most damagingly
//! malformed prose, the exact class the write gate (JP-328) has to heal. This
//! module gives them the rules up front: a hand-authored **content contract**
//! (what valid prose / shape input looks like) plus the repeatable **recipes**.
//!
//! **Traversal-safe by construction.** The recipe bodies are embedded at compile
//! time via `include_str!` into a fixed, closed table (`SKILLS`). A `skill`
//! argument is only ever *matched against* that table — it is never used to build
//! a filesystem path, so there is no path-traversal surface at all (no `..`, no
//! symlink, no disk read on the request path). The vendored copies under
//! `skills/` are kept honest against the canonical top-level `skills/` by
//! `vendored_skills_match_source` in the test module.

use serde_json::{json, Value};

/// The valid-content contract, surfaced so an agent authors schema-valid prose
/// and shapes the first time instead of relying on the relay to heal it. Kept in
/// lockstep with `sync::prose_validate` (the write gate) and the client prose
/// schema (`proseSchemaContract.test.ts`).
pub const CONTENT_CONTRACT: &str = r#"# DocuShark content contract (read before writing)

## Prose (set_prose / add_prose_page / insert_section)
- Pass Markdown by default, or well-formed HTML with format:"html".
- Allowed block types only: paragraph, heading (h1-h6), bulletList/orderedList
  (with listItem), blockquote, codeBlock, table, horizontalRule, image, figure
  (with figcaption), callout, gallery, math block. Anything else is unwrapped to
  its text.
- Atoms carry NO children: image, horizontalRule, hardBreak, an inline citation,
  a field reference, an inline/block math node. Never nest content inside them.
- LaTeX math: write `$$ … $$` on its own line for a block (display) equation, or
  `$ … $` for inline math — e.g. `$$\frac{a}{b}$$` or "cost is $O(n \log n)$".
  Backslash commands and subscripts survive verbatim (`\frac`, `\,`, `\%`,
  `x_{i}`). To keep prose dollars literal, an inline `$` only opens before a
  non-space, non-digit and closes after a non-space — so "$5 and $10" stays
  literal; `$` inside code stays literal. (Equivalent HTML with format:"html":
  `<div data-math-block data-latex="…"></div>` /
  `<span data-math-inline data-latex="…"></span>`.)
- Every <img> needs a real src (a blob:, https:, or data: URL). A src-less image
  is dropped — it would crash the editor.
- Tables must be rectangular: a <table> of <tr> rows, each row the same number of
  <td>/<th> cells, every cell holding block content. Ragged tables are padded.
- A page is never truly empty; an empty write leaves one empty paragraph.

## Shapes (generate_diagram / add_shape / connect)
- Prefer generate_diagram for anything with edges: pass nodes [{id,label,kind?}]
  and edges [{from,to,label?}] and let the relay lay it out. Don't hand-place
  coordinates — it fights the router.
- Shape ids must be unique; every edge endpoint must name an existing node id.
- Styling is inline per shape ({fill,stroke,strokeWidth,labelColor} or "AUTO").
- Use the exact field names — an unrecognized key (e.g. fillColor for style.fill)
  is dropped, and an out-of-range value (heading level, labelPosition) is clamped.

If a write reports a `fixes` array, the relay adjusted your input: it healed
malformed prose, **dropped** an unrecognized/invalid field (`dropped_unknown` /
`dropped_invalid`), or **clamped** a value (`clamped`). Each entry has an
`action` + `reason` (shape fixes also name the `field`). Read it, correct the
source, and re-send so nothing is silently lost."#;

/// `(slug, when-to-use, full SKILL.md body)`. Bodies embedded at compile time —
/// a fixed set, so `skill_body` can only ever return one of these (no fs lookup).
const SKILLS: &[(&str, &str, &str)] = &[
    (
        "architecture-rfc",
        "Author an architecture/design RFC with a system diagram.",
        include_str!("skills/architecture-rfc.SKILL.md"),
    ),
    (
        "document-codebase-module",
        "Document a code module: prose walkthrough plus a component diagram.",
        include_str!("skills/document-codebase-module.SKILL.md"),
    ),
    (
        "diagram-from-description",
        "Turn a described system/sequence into a clean, auto-laid-out diagram.",
        include_str!("skills/diagram-from-description.SKILL.md"),
    ),
    (
        "meeting-notes-to-doc",
        "Turn raw notes into a structured, outlined document.",
        include_str!("skills/meeting-notes-to-doc.SKILL.md"),
    ),
];

/// The catalogue (slug + when-to-use for every recipe) plus the content
/// contract — what `get_skills` returns with no `skill` argument.
pub fn catalogue_json() -> Value {
    let skills: Vec<Value> = SKILLS
        .iter()
        .map(|(slug, when, _)| json!({ "skill": slug, "whenToUse": when }))
        .collect();
    json!({
        "skills": skills,
        "contentContract": CONTENT_CONTRACT,
        "hint": "Call get_skills with { skill: \"<slug>\" } for a recipe's full steps.",
    })
}

/// The full SKILL.md body for `slug`, or `None` if it isn't one of the fixed
/// recipes. A plain table match — `slug` never touches the filesystem.
pub fn skill_body(slug: &str) -> Option<&'static str> {
    SKILLS
        .iter()
        .find(|(s, _, _)| *s == slug)
        .map(|(_, _, body)| *body)
}

/// Comma-separated valid slugs, for an educational error on an unknown name.
pub fn valid_slugs() -> String {
    SKILLS
        .iter()
        .map(|(s, _, _)| *s)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_lists_every_recipe_and_the_contract() {
        let cat = catalogue_json();
        let skills = cat["skills"].as_array().unwrap();
        assert_eq!(skills.len(), SKILLS.len());
        assert!(cat["contentContract"].as_str().unwrap().contains("content contract"));
    }

    #[test]
    fn known_slug_returns_its_body() {
        let body = skill_body("diagram-from-description").unwrap();
        assert!(body.contains("generate_diagram"), "expected the recipe body");
    }

    #[test]
    fn unknown_and_traversal_slugs_return_none() {
        // The whole point: a `skill` argument can never escape the fixed table.
        assert!(skill_body("nope").is_none());
        assert!(skill_body("../../../../etc/passwd").is_none());
        assert!(skill_body("..%2f..%2fetc%2fpasswd").is_none());
        assert!(skill_body("architecture-rfc/../meeting-notes-to-doc").is_none());
        assert!(skill_body("").is_none());
    }

    #[test]
    fn vendored_skills_match_source() {
        // Keep the vendored copies honest: each must byte-match the canonical
        // top-level skills/. Skips when the source tree isn't present (e.g. the
        // relay-only Docker build context), so it never breaks a hermetic build —
        // it only catches drift in dev / CI, where the full repo is checked out.
        use std::path::Path;
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
        if !root.exists() {
            return;
        }
        for (slug, _, vendored) in SKILLS {
            let src = root.join(slug).join("SKILL.md");
            let source = std::fs::read_to_string(&src)
                .unwrap_or_else(|e| panic!("reading canonical {src:?}: {e}"));
            assert_eq!(
                source, *vendored,
                "vendored relay/src/mcp/skills/{slug}.SKILL.md has drifted from \
                 skills/{slug}/SKILL.md — re-copy it",
            );
        }
    }
}
