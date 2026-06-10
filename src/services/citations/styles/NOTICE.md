# Vendored CSL styles — attribution

The `.csl` files in this directory are **Citation Style Language** style
definitions used by the citation formatter (JP-89). They are bundled (rather
than fetched at runtime) so citation formatting works offline — a core
DocuShark requirement.

These files are **not** part of the DocuShark codebase and are **not** licensed
under the repository's AGPL-3.0 license. They retain their original license:

> **License:** Creative Commons Attribution-ShareAlike 3.0 Unported
> (CC BY-SA 3.0) — <https://creativecommons.org/licenses/by-sa/3.0/>
>
> **Source:** the Citation Style Language project styles repository,
> <https://github.com/citation-style-language/styles>

| File | Style |
|---|---|
| `modern-language-association.csl` | MLA Handbook 9th edition (in-text) |
| `chicago-author-date.csl` | Chicago Manual of Style 18th edition (author-date) |

APA, Vancouver, and Harvard styles are provided by `@citation-js/plugin-csl`
and are not vendored here.

If these files are modified, the ShareAlike term requires the derivative to be
distributed under CC BY-SA 3.0 as well. Prefer pulling fresh, unmodified copies
from the upstream repository over editing them in place.
