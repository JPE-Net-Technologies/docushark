/**
 * Style Profile Studio — what a profile actually does, per shape family.
 *
 * The manager answers "which profile?"; the Studio answers "what *is* this
 * profile?". Each row is a set of shapes that are styleable identically, drawn
 * by the real shape handler under this profile, with every key it can receive
 * marked **saved** (the profile sets it) or **inherited** (the shape keeps its
 * own). See `coverage.ts` for why families are grouped by facet signature.
 *
 * Built-in profiles open read-only: `updateProfile` refuses to mutate them
 * (they're seeded from code), so offering edits that silently no-op would be
 * worse than not offering them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Cloud, Eraser } from 'lucide-react';
import { useStyleProfileStore, type StyleProfile } from '../../../store/styleProfileStore';
import { pushStyleProfiles } from '../../../store/styleProfileSync';
import { renderProfileSwatch } from '../profilePreview';
import {
  resolveStudioFamilies,
  forgetKey,
  UNIVERSAL_KEYS,
  type StudioFamily,
  type StudioKey,
} from './coverage';
import './StudioModal.css';

const PREVIEW_SIZE = 56;

/** Live preview of one family under the profile, drawn by the real handler. */
function FamilyPreview({ profile, shapeType }: { profile: StyleProfile; shapeType: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const propsKey = JSON.stringify(profile.properties);

  useEffect(() => {
    if (ref.current) {
      renderProfileSwatch(ref.current, profile, { size: PREVIEW_SIZE, shapeType });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsKey, shapeType]);

  return (
    <canvas
      ref={ref}
      className="sps-preview"
      style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      aria-hidden="true"
    />
  );
}

/** Render a saved value compactly — colours as a chip, everything else as text. */
function ValueChip({ value }: { value: unknown }) {
  if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) {
    return (
      <span className="sps-value">
        <span className="sps-swatch" style={{ background: value }} />
        <code>{value}</code>
      </span>
    );
  }
  if (value === null) return <span className="sps-value"><code>none</code></span>;
  if (typeof value === 'object') {
    const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
    return <span className="sps-value"><code>{Array.isArray(value) ? `${count} items` : 'configured'}</code></span>;
  }
  return <span className="sps-value"><code>{String(value)}</code></span>;
}

function KeyRow({
  entry,
  readOnly,
  onForget,
}: {
  entry: StudioKey;
  readOnly: boolean;
  onForget: (key: StudioKey['key']) => void;
}) {
  const universal = UNIVERSAL_KEYS.includes(entry.key);
  return (
    <li className={`sps-key ${entry.saved ? 'is-saved' : 'is-inherited'}`}>
      <span className="sps-key-state" aria-hidden="true" />
      <span className="sps-key-label">{entry.label}</span>
      {entry.saved ? (
        <ValueChip value={entry.value} />
      ) : (
        <span className="sps-value sps-value--inherited">inherited</span>
      )}
      {entry.saved && !readOnly && !universal && (
        <button
          className="sps-forget"
          onClick={() => onForget(entry.key)}
          title={`Forget ${entry.label} — shapes keep their own value`}
          aria-label={`Forget ${entry.label} from this profile`}
        >
          <Eraser size={13} />
        </button>
      )}
    </li>
  );
}

function FamilyRow({
  family,
  profile,
  readOnly,
  onForget,
}: {
  family: StudioFamily;
  profile: StyleProfile;
  readOnly: boolean;
  onForget: (key: StudioKey['key']) => void;
}) {
  const savedCount = family.keys.filter((k) => k.saved).length;
  return (
    <section className={`sps-family ${family.hasSavedKeys ? 'is-tuned' : ''}`}>
      <header className="sps-family-head">
        <FamilyPreview profile={profile} shapeType={family.representativeType} />
        <div className="sps-family-meta">
          <h3 className="sps-family-name">{family.label}</h3>
          <p className="sps-family-sub">
            {savedCount} of {family.keys.length} styles saved
            {family.types.length > 1 && ` · ${family.types.length} shapes`}
          </p>
        </div>
      </header>
      <ul className="sps-keys">
        {family.keys.map((entry) => (
          <KeyRow
            key={`${family.id}:${entry.key}`}
            entry={entry}
            readOnly={readOnly}
            onForget={onForget}
          />
        ))}
      </ul>
    </section>
  );
}

export function StudioModal({
  profileId,
  onClose,
}: {
  profileId: string;
  onClose: () => void;
}) {
  const profiles = useStyleProfileStore((s) => s.profiles);
  const updateProfile = useStyleProfileStore((s) => s.updateProfile);
  const profile = profiles.find((p) => p.id === profileId);
  const [onlyTuned, setOnlyTuned] = useState(false);

  const families = useMemo(
    () => (profile ? resolveStudioFamilies(profile) : []),
    [profile],
  );
  const visible = onlyTuned ? families.filter((f) => f.hasSavedKeys) : families;
  const readOnly = !profile || profile.id.startsWith('default-');

  const handleForget = useCallback(
    (key: StudioKey['key']) => {
      if (!profile || readOnly) return;
      updateProfile(profile.id, { properties: forgetKey(profile.properties, key) });
      if (profile.scope === 'workspace') void pushStyleProfiles();
    },
    [profile, readOnly, updateProfile],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!profile) return null;

  const tunedCount = families.filter((f) => f.hasSavedKeys).length;

  return (
    <div className="sps-backdrop" onClick={onClose} role="presentation">
      <div
        className="sps-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Style Profile Studio — ${profile.name}`}
      >
        <header className="sps-head">
          <div className="sps-title">
            <h2>{profile.name}</h2>
            <p className="sps-sub">
              Tuned for <strong>{tunedCount}</strong> of {families.length} shape sets
              {profile.scope === 'workspace' && (
                <span className="sps-synced">
                  <Cloud size={12} /> synced
                </span>
              )}
              {readOnly && <span className="sps-readonly">built-in · read-only</span>}
            </p>
          </div>
          <div className="sps-head-actions">
            <label className="sps-toggle">
              <input
                type="checkbox"
                checked={onlyTuned}
                onChange={(e) => setOnlyTuned(e.target.checked)}
              />
              Only tuned
            </label>
            <button className="sps-close" onClick={onClose} aria-label="Close the Studio">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="sps-body">
          {visible.length === 0 ? (
            <div className="sps-empty">
              {onlyTuned ? (
                <p>Nothing tuned yet. Clear the filter to see everything this profile can reach.</p>
              ) : (
                <>
                  <p>No shape styles saved yet.</p>
                  <p className="sps-empty-hint">
                    Select a shape on the canvas and choose <strong>Update with current</strong> to
                    teach this profile how that shape should look.
                  </p>
                </>
              )}
            </div>
          ) : (
            visible.map((family) => (
              <FamilyRow
                key={family.id}
                family={family}
                profile={profile}
                readOnly={readOnly}
                onForget={handleForget}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
