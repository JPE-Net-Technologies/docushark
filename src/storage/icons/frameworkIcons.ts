/**
 * Framework & Library Icons
 *
 * Icons sourced from simple-icons (simpleicons.org) — CC0 License.
 */

import type { BuiltinIcon } from './index';
import {
  siReact, siVuedotjs, siAngular, siSvelte, siNextdotjs, siExpress,
  siDjango, siFlask, siSpring, siSpringboot, siLaravel, siRubyonrails,
  siNestjs, siAstro, siGatsby, siRemix, siFastapi, siDeno, siBun,
  siNodedotjs, siElectron, siTauri, siFlutter, siDotnet, siBlazor,
  siHtmx, siAlpinedotjs, siQwik,
} from 'simple-icons';

function fromSi(icon: { title: string; path: string; slug: string }, nameOverride?: string): BuiltinIcon {
  return {
    name: nameOverride ?? icon.title,
    category: 'frameworks',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${icon.path}"/></svg>`,
  };
}

const frameworkIcons: BuiltinIcon[] = [
  fromSi(siReact),
  fromSi(siVuedotjs, 'Vue'),
  fromSi(siAngular),
  fromSi(siSvelte),
  fromSi(siNextdotjs, 'Next.js'),
  fromSi(siExpress),
  fromSi(siDjango),
  fromSi(siFlask),
  fromSi(siSpring),
  fromSi(siSpringboot),
  fromSi(siLaravel),
  fromSi(siRubyonrails, 'Rails'),
  fromSi(siNestjs),
  fromSi(siAstro),
  fromSi(siGatsby),
  fromSi(siRemix),
  fromSi(siFastapi),
  fromSi(siDeno),
  fromSi(siBun),
  fromSi(siNodedotjs, 'Node.js'),
  fromSi(siElectron),
  fromSi(siTauri),
  fromSi(siFlutter),
  fromSi(siDotnet),
  fromSi(siBlazor),
  fromSi(siHtmx),
  fromSi(siAlpinedotjs, 'Alpine.js'),
  fromSi(siQwik),
];

export default frameworkIcons;
