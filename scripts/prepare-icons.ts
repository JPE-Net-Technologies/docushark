#!/usr/bin/env node
/**
 * prepare-icons.ts
 *
 * Copies cloud provider SVG icons from NEW-ICONS/ into public/icons/
 * and generates manifest JSON files for each provider.
 *
 * Run: bun scripts/prepare-icons.ts
 */

import { readdir, copyFile, writeFile, stat, mkdir, readFile } from 'fs/promises';
import { join, basename } from 'path';

const ROOT = join(import.meta.dirname, '..');
const NEW_ICONS = join(ROOT, 'NEW-ICONS');
const PUBLIC_ICONS = join(ROOT, 'public', 'icons');

interface ManifestEntry {
  id: string;
  name: string;
  file: string;
}

/** Convert a raw filename into a clean display name. */
function cleanAwsName(filename: string): string {
  return filename
    .replace(/^Arch_/, '')
    .replace(/_64$/, '')
    .replace(/-/g, ' ')
    .replace(/\bAWS\b/g, 'AWS')
    .replace(/\bAmazon\b/g, 'Amazon')
    .trim();
}

function cleanAzureName(filename: string): string {
  return filename
    .replace(/^\d+\s*-icon-service-/, '')
    .replace(/-/g, ' ')
    .trim();
}

function cleanGcpName(dirname: string): string {
  return dirname
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bSql\b/g, 'SQL')
    .replace(/\bCdn\b/g, 'CDN')
    .replace(/\bIam\b/g, 'IAM')
    .replace(/\bVpc\b/g, 'VPC')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bIot\b/g, 'IoT')
    .replace(/\bGke\b/g, 'GKE')
    .replace(/\bTpu\b/g, 'TPU')
    .replace(/\bNlp\b/g, 'NLP')
    .replace(/\bDns\b/g, 'DNS')
    .trim();
}

/** Create a kebab-case ID from a display name. */
function toId(prefix: string, name: string): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `builtin:${prefix}-${kebab}`;
}

/** Clean a filename for use as the on-disk SVG name. */
function toFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + '.svg';
}

async function processAws(): Promise<void> {
  const srcDir = join(NEW_ICONS, 'AWS-Icons', 'Services');
  const destDir = join(PUBLIC_ICONS, 'aws');
  await mkdir(destDir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  const categories = await readdir(srcDir);

  for (const cat of categories) {
    const size64 = join(srcDir, cat, '64');
    let files: string[];
    try {
      files = await readdir(size64);
    } catch {
      continue; // skip if no 64/ subfolder
    }

    for (const file of files) {
      if (!file.endsWith('.svg')) continue;

      const rawName = file.replace('.svg', '');
      const displayName = cleanAwsName(rawName);
      const destFile = toFilename(displayName);
      const id = toId('aws', displayName);

      await copyFile(join(size64, file), join(destDir, destFile));
      manifest.push({ id, name: displayName, file: destFile });
    }
  }

  // Sort by name for consistent ordering
  manifest.sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(
    join(PUBLIC_ICONS, 'aws-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`AWS: ${manifest.length} icons`);
}

async function processAzure(): Promise<void> {
  const srcDir = join(NEW_ICONS, 'Azure-Icons', 'Icons');
  const destDir = join(PUBLIC_ICONS, 'azure');
  await mkdir(destDir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  const seen = new Set<string>(); // deduplicate by clean name

  const categories = await readdir(srcDir);
  for (const cat of categories) {
    const catPath = join(srcDir, cat);
    const catStat = await stat(catPath);
    if (!catStat.isDirectory()) continue;

    const files = await readdir(catPath);
    for (const file of files) {
      if (!file.endsWith('.svg')) continue;

      const rawName = file.replace('.svg', '');
      const displayName = cleanAzureName(rawName);
      if (!displayName || seen.has(displayName.toLowerCase())) continue;
      seen.add(displayName.toLowerCase());

      const destFile = toFilename(displayName);
      const id = toId('azure', displayName);

      await copyFile(join(catPath, file), join(destDir, destFile));
      manifest.push({ id, name: displayName, file: destFile });
    }
  }

  manifest.sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(
    join(PUBLIC_ICONS, 'azure-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`Azure: ${manifest.length} icons`);
}

async function processGcp(): Promise<void> {
  const srcDir = join(NEW_ICONS, 'GCP-Legacy-Icons');
  const destDir = join(PUBLIC_ICONS, 'gcp');
  await mkdir(destDir, { recursive: true });

  const manifest: ManifestEntry[] = [];
  const dirs = await readdir(srcDir);

  for (const dir of dirs) {
    const dirPath = join(srcDir, dir);
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) continue;

    // Find the SVG in this directory
    const files = await readdir(dirPath);
    const svgFile = files.find((f) => f.endsWith('.svg'));
    if (!svgFile) continue;

    const displayName = cleanGcpName(dir);
    const destFile = toFilename(displayName);
    const id = toId('gcp', displayName);

    await copyFile(join(dirPath, svgFile), join(destDir, destFile));
    manifest.push({ id, name: displayName, file: destFile });
  }

  manifest.sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(
    join(PUBLIC_ICONS, 'gcp-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`GCP: ${manifest.length} icons`);
}

async function main(): Promise<void> {
  console.log('Preparing cloud provider icons...');
  await processAws();
  await processAzure();
  await processGcp();
  console.log('Done! Manifests written to public/icons/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
