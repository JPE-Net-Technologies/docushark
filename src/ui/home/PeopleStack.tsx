/**
 * PeopleStack (JP-444) — the People cell on document rows/cards: an
 * initials-avatar stack of everyone on the document (owner first, then
 * shares), overflowing into "+N". Colors are deterministic per user id so the
 * same person reads consistently across rows.
 *
 * When the caller can manage access, the stack is a button opening the
 * permissions dialog — the avatars ARE the sharing entry, not decoration.
 */
import type { DocumentRecord } from '../../types/DocumentRegistry';
import './PeopleStack.css';

interface Person {
  id: string;
  name: string;
}

/** Owner first, then shares; skips entries without identity, dedupes by id. */
export function peopleForRecord(record: DocumentRecord): Person[] {
  if (record.type === 'local') return [];
  const out: Person[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined, name: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name || 'Unknown user' });
  };
  push(record.ownerId, record.ownerName);
  for (const share of record.sharedWith ?? []) push(share.userId, share.userName);
  return out;
}

/** Stable small hash → hue, so a user's avatar color never shifts. */
export function personHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

const MAX_AVATARS = 3;

export interface PeopleStackProps {
  record: DocumentRecord;
  /** Open the permissions dialog; when absent the stack is display-only. */
  onOpenAccess?: (() => void) | undefined;
}

export function PeopleStack({ record, onOpenAccess }: PeopleStackProps) {
  const people = peopleForRecord(record);
  if (people.length === 0) {
    return (
      <span className="people-stack people-stack--none" aria-label="No collaborator information">
        —
      </span>
    );
  }

  const shown = people.slice(0, MAX_AVATARS);
  const overflow = people.length - shown.length;
  const names = people.map((p) => p.name);
  const label =
    `Owner: ${names[0]}` +
    (names.length > 1 ? ` · Shared with ${names.slice(1).join(', ')}` : '') +
    (onOpenAccess ? ' · Click to manage access' : '');

  const body = (
    <>
      {shown.map((p) => (
        <span
          key={p.id}
          className="people-stack__avatar"
          style={{ background: `hsl(${personHue(p.id)} 38% 46%)` }}
          aria-hidden="true"
        >
          {initials(p.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="people-stack__avatar people-stack__avatar--more" aria-hidden="true">
          +{overflow}
        </span>
      )}
    </>
  );

  if (onOpenAccess) {
    return (
      <button
        type="button"
        className="people-stack people-stack--button"
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onOpenAccess();
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className="people-stack" title={label} aria-label={label}>
      {body}
    </span>
  );
}

export default PeopleStack;
