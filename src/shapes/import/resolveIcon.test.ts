import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchIconId, normalizeTokens, providerCategory } from './resolveIcon';
import type { IconMetadata } from '../../storage/IconTypes';

/** Load a real bundled cloud manifest as IconMetadata (matches the runtime shape). */
function manifest(file: string, category: IconMetadata['category']): IconMetadata[] {
  const raw = readFileSync(resolve(process.cwd(), `public/icons/${file}`), 'utf8');
  return (JSON.parse(raw) as Array<{ id: string; name: string }>).map((e) => ({
    id: e.id, name: e.name, type: 'builtin', category,
  }));
}

const AWS = manifest('aws-manifest.json', 'cloud-aws');
const GCP = manifest('gcp-manifest.json', 'cloud-gcp');

describe('normalizeTokens', () => {
  it('drops provider/filler noise so a leaf can match a full name', () => {
    expect(normalizeTokens('AWS Lambda')).toEqual(['lambda']);
    expect(normalizeTokens('Amazon EC2')).toEqual(['ec2']);
    expect(normalizeTokens('mxgraph.aws4.lambda')).toEqual(['lambda']);
  });
});

describe('providerCategory', () => {
  it('maps stencil provider prefixes to catalog categories', () => {
    expect(providerCategory('aws4')).toBe('cloud-aws');
    expect(providerCategory('azure')).toBe('cloud-azure');
    expect(providerCategory('gcp2')).toBe('cloud-gcp');
    expect(providerCategory('cisco')).toBeNull();
  });
});

describe('matchIconId (against the real bundled manifests)', () => {
  it('resolves a drawio leaf to the right catalog icon', () => {
    expect(matchIconId('lambda', AWS)).toBe('builtin:aws-aws-lambda');
    expect(matchIconId('ec2', AWS)).toBe('builtin:aws-amazon-ec2');
  });

  it('resolves an abbreviation to a service that carries it (best-effort)', () => {
    // The catalog has no plain "Amazon S3" (it's "Simple Storage Service"), so
    // `s3` lands on the most specific service whose name *does* carry the token
    // — a real example of why stencil-name coverage wants tuning vs. a real
    // cloud-architecture asset. Better an s3-family icon than a blank box.
    const s3 = matchIconId('s3', AWS);
    expect(s3).toBeTruthy();
    expect(s3).toContain('s3');
  });

  it('prefers the most specific full-coverage match', () => {
    // Both "Compute Engine" and "Migrate For Compute Engine" cover the query.
    expect(matchIconId('compute engine', GCP)).toBe('builtin:gcp-compute-engine');
  });

  it('returns null when nothing covers every query token', () => {
    expect(matchIconId('definitely-not-a-real-service-xyz', AWS)).toBeNull();
    expect(matchIconId('', AWS)).toBeNull();
  });
});
