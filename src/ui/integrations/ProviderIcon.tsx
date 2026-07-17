/**
 * ProviderIcon (JP-415) — the brand mark for an integration provider, used
 * wherever a mirror page or integration action needs its source visually
 * identified (tab glyph, add-menu entries, the resource picker's header).
 *
 * Provider marks are bundled SVG assets (one per provider under
 * `assets/integrations/`); an unknown provider id falls back to a neutral
 * link glyph so a mirror page never renders blank when its provider isn't in
 * this build's catalog. Marks are used solely to identify the integrated
 * service, in line with each provider's brand guidelines; trademarks remain
 * with their owners (same posture as the bundled cloud icon set).
 */
import { Link2 } from 'lucide-react';
import { Icon } from '../icons';
import notionIconUrl from '../../assets/integrations/notion.svg';

const PROVIDER_ICONS: Record<string, string> = {
  notion: notionIconUrl,
};

interface ProviderIconProps {
  /** Connector id from the control plane (e.g. 'notion'). */
  provider: string;
  size?: number;
  className?: string;
}

export function ProviderIcon({ provider, size = 13, className }: ProviderIconProps) {
  const url = PROVIDER_ICONS[provider];
  if (!url) return <Icon icon={Link2} size={size} className={className} />;
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      {...(className ? { className } : {})}
    />
  );
}
