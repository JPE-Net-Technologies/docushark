/**
 * Initials avatar — a small identity circle for people rows (workspace
 * members, document shares). Derives 1–2 letters and a deterministic hue from
 * the display name, so the same person renders the same chip everywhere
 * without any image infrastructure.
 */
import './InitialsAvatar.css';

/** Fixed hue palette tuned to read on both themes (chip text is always light). */
const HUES = [212, 258, 160, 22, 340, 190, 92, 302] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return HUES[Math.abs(hash) % HUES.length]!;
}

export interface InitialsAvatarProps {
  name: string;
  /** Diameter in px (default 26 — sized for list rows). */
  size?: number;
}

export function InitialsAvatar({ name, size = 26 }: InitialsAvatarProps) {
  const hue = hueOf(name);
  return (
    <span
      className="initials-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${hue} 42% 38%)`,
      }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

export default InitialsAvatar;
