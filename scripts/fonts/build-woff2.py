"""Generate each bundled font's WOFF2 from its TTF, and prove they measure alike.

The PDF embeds the TTF; the screen loads the WOFF2. Text then measures the same
on screen and on paper only if both carry identical metrics, so after writing
each WOFF2 this reads it back and compares it with its TTF: glyph order,
character map, advance widths and side bearings, kerning-free vertical metrics.

Usage (no install needed):
    uv run --with fonttools,brotli python scripts/fonts/build-woff2.py [FONT_DIR]

FONT_DIR defaults to src/assets/fonts; every `*.ttf` below it gets a `.woff2`
beside it. Re-running rewrites them byte for byte: the source's timestamp and
bounding boxes are kept, so the output depends only on the TTF.
"""

import pathlib
import sys

from fontTools.ttLib import TTFont

FONT_DIR = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'src/assets/fonts')


def metrics(font: TTFont) -> dict:
    """What layout reads: the glyphs, the character map and every metric."""
    head, hhea, os2 = font['head'], font['hhea'], font['OS/2']
    return {
        'glyphOrder': font.getGlyphOrder(),
        'cmap': font.getBestCmap(),
        'hmtx': dict(font['hmtx'].metrics),
        'unitsPerEm': head.unitsPerEm,
        'hhea': (hhea.ascent, hhea.descent, hhea.lineGap),
        'os2': (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap, os2.usWinAscent, os2.usWinDescent),
    }


def main() -> int:
    ttfs = sorted(FONT_DIR.rglob('*.ttf'))
    if not ttfs:
        print(f'no .ttf files under {FONT_DIR}')
        return 1
    failures = 0
    for ttf in ttfs:
        woff2 = ttf.with_suffix('.woff2')
        # Keep the source's `head.modified` and bounding boxes: fontTools would
        # otherwise stamp the current time, and the output would change per run.
        font = TTFont(ttf, recalcTimestamp=False, recalcBBoxes=False)
        font.flavor = 'woff2'
        font.save(woff2)
        same = metrics(TTFont(ttf)) == metrics(TTFont(woff2))
        failures += 0 if same else 1
        print(f"{'ok      ' if same else 'MISMATCH'} {ttf.stat().st_size:>8} -> {woff2.stat().st_size:>7}  {woff2}")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
