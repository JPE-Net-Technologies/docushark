/**
 * DevOps & Infrastructure Icons
 *
 * Icons sourced from simple-icons (simpleicons.org) — CC0 License.
 */

import type { BuiltinIcon } from './index';
import {
  siDocker, siKubernetes, siTerraform, siAnsible, siJenkins,
  siGithubactions, siGitlab, siCircleci, siNginx, siApache, siCaddy,
  siPrometheus, siGrafana, siDatadog, siNewrelic, siPagerduty,
  siVault, siConsul, siPacker, siVagrant, siPuppet, siChef,
  siLinux, siUbuntu, siDebian, siRedhat, siFedora, siArchlinux,
  siAlpinelinux, siNixos, siGit, siGithub, siBitbucket, siHelm,
  siIstio, siPulumi, siCloudflare,
} from 'simple-icons';

function fromSi(icon: { title: string; path: string; slug: string }, nameOverride?: string): BuiltinIcon {
  return {
    name: nameOverride ?? icon.title,
    category: 'devops',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${icon.path}"/></svg>`,
  };
}

const devopsIcons: BuiltinIcon[] = [
  fromSi(siDocker),
  fromSi(siKubernetes),
  fromSi(siTerraform),
  fromSi(siAnsible),
  fromSi(siJenkins),
  fromSi(siGithubactions),
  fromSi(siGitlab),
  fromSi(siCircleci),
  fromSi(siNginx),
  fromSi(siApache),
  fromSi(siCaddy),
  fromSi(siPrometheus),
  fromSi(siGrafana),
  fromSi(siDatadog),
  fromSi(siNewrelic),
  fromSi(siPagerduty),
  fromSi(siVault),
  fromSi(siConsul),
  fromSi(siPacker),
  fromSi(siVagrant),
  fromSi(siPuppet),
  fromSi(siChef),
  fromSi(siLinux),
  fromSi(siUbuntu),
  fromSi(siDebian),
  fromSi(siRedhat, 'Red Hat'),
  fromSi(siFedora),
  fromSi(siArchlinux),
  fromSi(siAlpinelinux),
  fromSi(siNixos),
  fromSi(siGit),
  fromSi(siGithub),
  fromSi(siBitbucket),
  fromSi(siHelm),
  fromSi(siIstio),
  fromSi(siPulumi),
  fromSi(siCloudflare),
];

export default devopsIcons;
