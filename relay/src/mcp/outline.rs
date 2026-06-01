//! Minimal HTML outline utilities for the MCP prose-structure tools (JP-93).
//!
//! Prose pages are stored as HTML; the editor (and our Markdown renderer)
//! emit clean, attribute-free `<h1>..<h6>` blocks. We model a page as an
//! optional **prefix** (any content before the first heading) plus a **flat
//! list of sections**, where each section is a heading plus the content that
//! follows it up to the next heading of *any* level.
//!
//! Flat (rather than nested) sectioning keeps reorder / promote / demote
//! predictable and lossless to round-trip: nesting is conveyed by the level
//! number, not by containment. Moving a section moves just its own heading +
//! immediate body, not descendant subsections — the agent moves those
//! separately if it wants to. This is intentional and documented on the MCP
//! tools.
//!
//! Headings are re-emitted from `level` + `inner_html`, so any attributes on
//! a passed-through `<h1 id="...">` are dropped on a structural edit; the
//! editor's headings carry none, so this is a non-issue in practice.

/// One flat section: a heading and the content immediately following it.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// Heading level, 1–6.
    pub level: u8,
    /// Inner HTML of the heading (may contain inline markup like `<em>`).
    pub inner_html: String,
    /// Plain-text heading title (tags stripped) — for the outline listing.
    pub title: String,
    /// HTML following the heading, up to the next heading (or end of page).
    pub body_html: String,
}

impl Section {
    fn heading_html(&self) -> String {
        format!("<h{0}>{1}</h{0}>", self.level, self.inner_html)
    }
}

/// A parsed prose page: leading content plus its flat sections.
#[derive(Debug, Clone, PartialEq)]
pub struct Outline {
    pub prefix: String,
    pub sections: Vec<Section>,
}

impl Outline {
    /// Parse a prose-page HTML string into prefix + flat sections.
    pub fn parse(html: &str) -> Outline {
        let headings = heading_spans(html);
        if headings.is_empty() {
            return Outline {
                prefix: html.to_string(),
                sections: Vec::new(),
            };
        }

        let prefix = html[..headings[0].open_start].to_string();
        let mut sections = Vec::with_capacity(headings.len());
        for (idx, h) in headings.iter().enumerate() {
            let body_start = h.after_close;
            let body_end = headings
                .get(idx + 1)
                .map(|next| next.open_start)
                .unwrap_or(html.len());
            let inner_html = html[h.content_start..h.close_start].to_string();
            sections.push(Section {
                level: h.level,
                title: strip_tags(&inner_html),
                inner_html,
                body_html: html[body_start..body_end].to_string(),
            });
        }

        Outline { prefix, sections }
    }

    /// Reassemble the page HTML. `Outline::parse(x).to_html()` reproduces `x`
    /// for editor/Markdown-generated HTML (headings carry no attributes).
    pub fn to_html(&self) -> String {
        let mut out = String::with_capacity(self.prefix.len() + 64 * self.sections.len());
        out.push_str(&self.prefix);
        for s in &self.sections {
            out.push_str(&s.heading_html());
            out.push_str(&s.body_html);
        }
        out
    }
}

struct HeadingSpan {
    /// Byte index of the `<` in `<hN>`.
    open_start: usize,
    /// Byte index just after the `>` of the opening tag.
    content_start: usize,
    /// Byte index of the `<` in `</hN>`.
    close_start: usize,
    /// Byte index just after the `>` of the closing tag.
    after_close: usize,
    level: u8,
}

/// Locate well-formed, non-nested `<hN>...</hN>` blocks in document order.
/// A stray `<h7` or unmatched tag is skipped, not treated as a heading.
fn heading_spans(html: &str) -> Vec<HeadingSpan> {
    let mut spans = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = html[i..].find("<h") {
        let open_start = i + rel;
        let level_idx = open_start + 2;
        let level = html[level_idx..].chars().next().and_then(|c| {
            if ('1'..='6').contains(&c) {
                Some(c as u8 - b'0')
            } else {
                None
            }
        });
        // Find the end of the opening tag and the matching close tag.
        if let Some(level) = level {
            if let Some(gt_rel) = html[level_idx..].find('>') {
                let content_start = level_idx + gt_rel + 1;
                let close_tag = format!("</h{}>", level);
                if let Some(close_rel) = html[content_start..].find(&close_tag) {
                    let close_start = content_start + close_rel;
                    let after_close = close_start + close_tag.len();
                    spans.push(HeadingSpan {
                        open_start,
                        content_start,
                        close_start,
                        after_close,
                        level,
                    });
                    i = after_close;
                    continue;
                }
            }
        }
        // Not a real heading start — step past this "<h" and keep scanning.
        i = level_idx;
    }
    spans
}

/// Strip HTML tags, yielding the visible text of a heading. Good enough for
/// titles (which are short and tag-light); not a general HTML-to-text pass.
pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Escape text for safe insertion as HTML inner content.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Clamp a heading level into the legal 1–6 range.
pub fn clamp_level(level: i64) -> u8 {
    level.clamp(1, 6) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "<p>intro</p><h1>Alpha</h1><p>a body</p><h2>Beta</h2><p>b body</p><h1>Gamma</h1>";

    #[test]
    fn parse_then_to_html_round_trips() {
        let o = Outline::parse(DOC);
        assert_eq!(o.to_html(), DOC);
    }

    #[test]
    fn parse_extracts_prefix_and_sections() {
        let o = Outline::parse(DOC);
        assert_eq!(o.prefix, "<p>intro</p>");
        assert_eq!(o.sections.len(), 3);
        assert_eq!(o.sections[0].level, 1);
        assert_eq!(o.sections[0].title, "Alpha");
        assert_eq!(o.sections[0].body_html, "<p>a body</p>");
        assert_eq!(o.sections[1].level, 2);
        assert_eq!(o.sections[1].title, "Beta");
        assert_eq!(o.sections[2].title, "Gamma");
        assert_eq!(o.sections[2].body_html, "");
    }

    #[test]
    fn no_headings_means_all_prefix() {
        let o = Outline::parse("<p>just text</p>");
        assert!(o.sections.is_empty());
        assert_eq!(o.prefix, "<p>just text</p>");
    }

    #[test]
    fn strip_tags_handles_inline_markup() {
        assert_eq!(strip_tags("An <em>italic</em> title"), "An italic title");
    }

    #[test]
    fn promote_demote_relevels_only_that_heading() {
        let mut o = Outline::parse(DOC);
        o.sections[1].level = clamp_level(o.sections[1].level as i64 - 1); // Beta h2 -> h1
        assert!(o.to_html().contains("<h1>Beta</h1>"));
        // Others unchanged.
        assert!(o.to_html().contains("<h1>Alpha</h1>"));
    }

    #[test]
    fn level_clamps_at_bounds() {
        assert_eq!(clamp_level(0), 1);
        assert_eq!(clamp_level(7), 6);
        assert_eq!(clamp_level(3), 3);
    }

    #[test]
    fn moving_a_section_reorders_heading_and_body() {
        let mut o = Outline::parse(DOC);
        let moved = o.sections.remove(2); // Gamma
        o.sections.insert(0, moved);
        let html = o.to_html();
        // Gamma now precedes Alpha.
        assert!(html.find("Gamma").unwrap() < html.find("Alpha").unwrap());
    }

    #[test]
    fn skips_invalid_heading_like_tokens() {
        let o = Outline::parse("<h7>not a heading</h7><h1>real</h1>");
        assert_eq!(o.sections.len(), 1);
        assert_eq!(o.sections[0].title, "real");
        assert!(o.prefix.contains("<h7>not a heading</h7>"));
    }
}
