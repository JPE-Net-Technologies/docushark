/**
 * Programming Language Icons
 *
 * Icons sourced from simple-icons (simpleicons.org) — CC0 License.
 * Falls back to inline SVG for icons not available in simple-icons.
 */

import type { BuiltinIcon } from './index';
import {
  siJavascript, siTypescript, siHtml5, siCss, siPython, siRust, siGo,
  siCplusplus, siC, siPhp, siRuby, siSwift, siKotlin, siScala, siDart,
  siLua, siR, siPerl, siHaskell, siElixir, siClojure, siZig, siFortran,
  siGnubash, siOcaml, siFsharp, siJulia, siErlang, siWebassembly,
  siSolidity, siNim, siCrystal, siV, siGleam, siOdin, siOpenjdk, siDotnet,
  siAssemblyscript, siShell,
} from 'simple-icons';

function fromSi(icon: { title: string; path: string; slug: string }, nameOverride?: string): BuiltinIcon {
  return {
    name: nameOverride ?? icon.title,
    category: 'languages',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${icon.path}"/></svg>`,
  };
}

const languageIcons: BuiltinIcon[] = [
  fromSi(siJavascript),
  fromSi(siTypescript),
  fromSi(siHtml5),
  fromSi(siCss, 'CSS3'),
  fromSi(siPython),
  fromSi(siRust),
  fromSi(siGo),
  fromSi(siOpenjdk, 'Java'),
  fromSi(siDotnet, 'C#'),
  fromSi(siCplusplus, 'C++'),
  fromSi(siC),
  fromSi(siPhp, 'PHP'),
  fromSi(siRuby),
  fromSi(siSwift),
  fromSi(siKotlin),
  fromSi(siScala),
  fromSi(siDart),
  fromSi(siLua),
  fromSi(siR),
  fromSi(siPerl),
  fromSi(siHaskell),
  fromSi(siElixir),
  fromSi(siClojure),
  fromSi(siZig),
  fromSi(siFortran),
  fromSi(siGnubash, 'Bash'),
  fromSi(siShell, 'Shell'),
  fromSi(siOcaml, 'OCaml'),
  fromSi(siFsharp, 'F#'),
  fromSi(siJulia),
  fromSi(siErlang),
  fromSi(siAssemblyscript, 'AssemblyScript'),
  fromSi(siWebassembly, 'WebAssembly'),
  fromSi(siSolidity),
  fromSi(siNim),
  fromSi(siCrystal),
  fromSi(siV),
  fromSi(siGleam),
  fromSi(siOdin),
];

export default languageIcons;
