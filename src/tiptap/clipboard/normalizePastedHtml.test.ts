/**
 * Pasted HTML from Word and Google Docs, tidied before the parse (DSK-208).
 */
import { describe, it, expect } from 'vitest';
import { normalizePastedHtml, isDefaultInk } from './normalizePastedHtml';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

/** The list structure as a compact string: `ul(First,ul(Nested),Second)`. */
function lists(root: Element): string {
  const shape = (list: Element): string =>
    `${list.tagName.toLowerCase()}(${Array.from(list.children)
      .map((li) => {
        const text = li.querySelector(':scope > p')?.textContent?.trim() ?? '';
        const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
        return [text, ...nested.map(shape)].join(',');
      })
      .join(',')})`;
  return Array.from(root.querySelectorAll(':scope > ul, :scope > ol')).map(shape).join(' ');
}

// Word, downlevel-revealed conditional comments around the marker.
const WORD_BULLETS = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body lang=EN-US><!--StartFragment-->
<h1><span style='color:windowtext'>Quarterly Report<o:p></o:p></span></h1>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]>First bullet<o:p></o:p></p>
<p class=MsoListParagraphCxSpMiddle style='margin-left:1.0in;text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='font-family:"Courier New"'>o<span>&nbsp;&nbsp; </span></span><![endif]>Nested bullet<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'>·<span>&nbsp;&nbsp; </span></span><![endif]>Second bullet<o:p></o:p></p>
<!--EndFragment--></body></html>`;

// Word, real comments and mso-list:Ignore spans; numbers, then letters a level down.
const WORD_NUMBERS = `<body>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><!--[if !supportLists]--><span style='mso-list:Ignore'>1.<span>&nbsp;&nbsp;&nbsp;</span></span><!--[endif]-->One</p>
<p class=MsoListParagraph style='mso-list:l1 level2 lfo2'><!--[if !supportLists]--><span style='mso-list:Ignore'>a.<span>&nbsp;&nbsp;&nbsp;</span></span><!--[endif]-->One a</p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><!--[if !supportLists]--><span style='mso-list:Ignore'>2.<span>&nbsp;&nbsp;&nbsp;</span></span><!--[endif]-->Two</p>
</body>`;

describe('normalizePastedHtml: Word lists (DSK-208)', () => {
  it('turns bullet paragraphs into a nested list without the markers', () => {
    const body = parse(normalizePastedHtml(WORD_BULLETS).html);
    expect(lists(body)).toBe('ul(First bullet,ul(Nested bullet),Second bullet)');
    expect(body.textContent).not.toMatch(/[·]|\bo\u00a0/);
  });

  it('turns numbered paragraphs into ordered lists, with the comment and Ignore-span syntax', () => {
    const body = parse(normalizePastedHtml(WORD_NUMBERS).html);
    expect(lists(body)).toBe('ol(One,ol(One a),Two)');
    expect(body.textContent).not.toMatch(/1\.|a\./);
  });

  it('starts a new list when the type changes at the same level', () => {
    const html = `<body>
<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·&nbsp;</span>Bullet</p>
<p style='mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>1.&nbsp;</span>Number</p>
</body>`;
    expect(lists(parse(normalizePastedHtml(html).html))).toBe('ul(Bullet) ol(Number)');
  });

  it('keeps separate lists apart when a paragraph sits between them', () => {
    const html = `<body>
<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·&nbsp;</span>A</p>
<p class=MsoNormal>Between</p>
<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·&nbsp;</span>B</p>
</body>`;
    const body = parse(normalizePastedHtml(html).html);
    expect(lists(body)).toBe('ul(A) ul(B)');
    expect(body.querySelector(':scope > p')?.textContent).toBe('Between');
  });

  it('drops Office markup: o:p, comments, style blocks', () => {
    const html = normalizePastedHtml(`<body><style>p{}</style><p>Text<o:p></o:p></p><!--StartFragment--></body>`).html;
    expect(html).toBe('<p>Text</p>');
  });
});

describe('normalizePastedHtml: colours (DSK-208)', () => {
  it("drops the source's default ink and paper, and keeps chosen colours", () => {
    const html = `<body><p>
<span style="color:windowtext">a</span><span style="color:black">b</span><span style="color:#000000">c</span>
<span style="color: rgb(0, 0, 0)">d</span><span style="color:#262626">e</span><span style="color:#FFFFFF">f</span>
<span style="color:#C00000">red</span><span style="color:#1F3864">navy</span>
<span style="background-color:transparent;font-weight:700">bold</span><span style="background:white">g</span>
</p></body>`;
    const body = parse(normalizePastedHtml(html).html);
    const style = (text: string) =>
      Array.from(body.querySelectorAll('span')).find((s) => s.textContent === text)?.getAttribute('style') ?? null;
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(style(text)).toBeNull();
    expect(style('red')).toMatch(/color:\s*#C00000/i);
    expect(style('navy')).toMatch(/color:\s*#1F3864/i);
    expect(style('bold')).toBe('font-weight:700');
  });

  it('cleans a Google Docs paste', () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-size:11pt;color:#000000;background-color:transparent;font-weight:700;">Bold</span></p></b>`;
    const span = parse(normalizePastedHtml(html).html).querySelector('span');
    expect(span?.getAttribute('style')).toBe('font-size:11pt; font-weight:700');
  });

  it('leaves colours alone in HTML copied from a ProseMirror editor', () => {
    const html = `<p data-pm-slice="1 1 []"><span style="color: black">chosen</span></p>`;
    expect(normalizePastedHtml(html).html).toContain('color: black');
  });

  it('classifies ink', () => {
    expect(isDefaultInk('windowtext')).toBe(true);
    expect(isDefaultInk('#404040')).toBe(true);
    expect(isDefaultInk('#7f7f7f')).toBe(false);
    expect(isDefaultInk('#c00000')).toBe(false);
  });
});

describe('normalizePastedHtml: images (DSK-208)', () => {
  it('unwraps an image-only paragraph so no empty paragraph is left above it', () => {
    const body = parse(normalizePastedHtml(`<body><p class=MsoNormal><img src="${PNG}" alt="Chart"><o:p></o:p></p></body>`).html);
    expect(body.querySelector('p')).toBeNull();
    expect(body.querySelector(':scope > img')?.getAttribute('alt')).toBe('Chart');
  });

  it('drops images the page cannot read, and counts them', () => {
    const result = normalizePastedHtml(
      `<body><p>Text</p><img src="file:///C:/Users/x/AppData/Local/Temp/clip_image001.png"><img src="cid:image001"><img src="${PNG}"><img></body>`,
    );
    const body = parse(result.html);
    expect(result.droppedImages).toBe(2);
    expect(Array.from(body.querySelectorAll('img')).map((i) => i.getAttribute('src'))).toEqual([PNG]);
  });

  it('drops unreadable images even from ProseMirror HTML', () => {
    expect(normalizePastedHtml(`<p data-pm-slice="0 0 []">a</p><img src="file:///x.png">`).droppedImages).toBe(1);
  });
});
