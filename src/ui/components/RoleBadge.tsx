/**
 * Role / permission badge — the one pill used everywhere a person's workspace
 * role or a share's permission is shown (members roster, document shares).
 * Icon + tinted background per semantic weight, consuming theme tokens only.
 */
import { Crown, Pencil, Eye, Users, type LucideIcon } from 'lucide-react';
import './RoleBadge.css';

/** Workspace roles + document-share permissions share one visual language. */
export type BadgeRole = 'owner' | 'admin' | 'member' | 'viewer' | 'edit' | 'view';

const VARIANTS: Record<BadgeRole, { icon: LucideIcon; label: string; tone: string }> = {
  owner: { icon: Crown, label: 'Owner', tone: 'owner' },
  admin: { icon: Crown, label: 'Admin', tone: 'owner' },
  member: { icon: Users, label: 'Member', tone: 'member' },
  edit: { icon: Pencil, label: 'Can edit', tone: 'member' },
  viewer: { icon: Eye, label: 'Viewer', tone: 'viewer' },
  view: { icon: Eye, label: 'Can view', tone: 'viewer' },
};

export interface RoleBadgeProps {
  role: BadgeRole;
  /** Override the default label (e.g. "You"). */
  label?: string;
}

export function RoleBadge({ role, label }: RoleBadgeProps) {
  const variant = VARIANTS[role];
  const Icon = variant.icon;
  return (
    <span className={`role-badge role-badge--${variant.tone}`}>
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
      {label ?? variant.label}
    </span>
  );
}

export default RoleBadge;
