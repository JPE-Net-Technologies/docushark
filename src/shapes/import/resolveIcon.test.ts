import { describe, it, expect } from 'vitest';
import { matchIconId, normalizeTokens, providerCategory } from './resolveIcon';
import type { IconMetadata } from '../../storage/IconTypes';

// Inline fixtures mirroring real catalog entries (id + name shape). The cloud
// catalog itself is generated and gitignored (`public/icons/`), so tests must
// not read it — coverage against the real manifests is a separate local script.
const icon = (id: string, name: string, category: IconMetadata['category']): IconMetadata => ({
  id, name, type: 'builtin', category,
});

const AWS = [
  icon('builtin:aws-aws-lambda', 'AWS Lambda', 'cloud-aws'),
  icon('builtin:aws-amazon-ec2', 'Amazon EC2', 'cloud-aws'),
  icon('builtin:aws-amazon-ec2-auto-scaling', 'Amazon EC2 Auto Scaling', 'cloud-aws'),
  icon('builtin:aws-amazon-simple-storage-service', 'Amazon Simple Storage Service', 'cloud-aws'),
  icon('builtin:aws-amazon-s3-on-outposts', 'Amazon S3 on Outposts', 'cloud-aws'),
];
const GCP = [
  icon('builtin:gcp-compute-engine', 'Compute Engine', 'cloud-gcp'),
  icon('builtin:gcp-migrate-for-compute-engine', 'Migrate For Compute Engine', 'cloud-gcp'),
];

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

describe('matchIconId', () => {
  it('resolves a drawio leaf to the right catalog icon', () => {
    expect(matchIconId('lambda', AWS)).toBe('builtin:aws-aws-lambda');
    expect(matchIconId('ec2', AWS)).toBe('builtin:aws-amazon-ec2');
  });

  it('prefers the most specific full-coverage match', () => {
    // Both EC2 entries cover {ec2}; the smaller token set wins.
    expect(matchIconId('ec2', AWS)).toBe('builtin:aws-amazon-ec2');
    // Both Compute Engine entries cover {compute, engine}.
    expect(matchIconId('compute engine', GCP)).toBe('builtin:gcp-compute-engine');
  });

  it('resolves an abbreviation only to a service that literally carries it', () => {
    // The main S3 service is "Simple Storage Service" — no `s3` token — so `s3`
    // lands on the S3-on-Outposts entry. A real example of why stencil-name
    // coverage wants tuning vs. a real cloud asset; better than a blank box.
    const s3 = matchIconId('s3', AWS);
    expect(s3).toBe('builtin:aws-amazon-s3-on-outposts');
  });

  it('returns null when nothing covers every query token', () => {
    expect(matchIconId('definitely-not-a-real-service-xyz', AWS)).toBeNull();
    expect(matchIconId('', AWS)).toBeNull();
  });
});
