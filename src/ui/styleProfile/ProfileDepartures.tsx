/**
 * Where the selection departs from its style profile (DSK-224). The provider works
 * it out once for the panel, and `ProfileProp` marks each row that differs, with a
 * reset. The rows are hand-written, across two render paths, so a row opts in by
 * being wrapped. Its inputs needn't know profiles exist.
 *
 * The Style row's count is the rows marked, not the properties that differ. A
 * profile also sets things you can't see or change here, such as a group's fill
 * (groups draw their background colour), and "2 changes" with nothing marked
 * anywhere would send you looking for something that isn't there.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { RotateCcw } from 'lucide-react';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  getProfilePropertyUpdate,
  getProfileUpdates,
  resolveSelectionStyle,
  useStyleProfileStore,
  type StyleProfile,
} from '../../store/styleProfileStore';
import type { Shape } from '../../shapes/Shape';
import { tip } from '../TooltipLayer';
import './ProfileDepartures.css';

interface ProfileDeparturesValue {
  /** The profile the selection goes with, if it goes with one. */
  profile: StyleProfile | null;
  /** The properties where it differs. */
  departures: ReadonlySet<string>;
  /** How many of them have a row to mark. */
  changes: number;
  /** A marked row says so, and takes it back on leaving. */
  mark: (name: string) => () => void;
  /** Back to the profile's values: this property, or all of them. */
  reset: (name?: string) => void;
}

const NOTHING: ReadonlySet<string> = new Set();

const ProfileDeparturesContext = createContext<ProfileDeparturesValue>({
  profile: null,
  departures: NOTHING,
  changes: 0,
  mark: () => () => {},
  reset: () => {},
});

export const useProfileDepartures = () => useContext(ProfileDeparturesContext);

/** The profiles on offer, in their usual order: a hidden one is one you asked not to see. */
export function useOfferedProfiles(): StyleProfile[] {
  const profiles = useStyleProfileStore((state) => state.profiles);
  const hideDefaults = useSettingsStore((state) => state.hideDefaultStyleProfiles);
  return useMemo(
    () =>
      useStyleProfileStore
        .getState()
        .getSortedProfiles()
        .filter((candidate) => !hideDefaults || !candidate.id.startsWith('default-')),
    // `profiles` is what getSortedProfiles reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profiles, hideDefaults],
  );
}

/** The profile a selection goes with, and where it differs. A hidden one is named only if applied. */
export function useSelectionStyle(selected: Shape[]) {
  const profiles = useStyleProfileStore((state) => state.profiles);
  const offered = useOfferedProfiles();
  return useMemo(() => {
    const sorted = useStyleProfileStore.getState().getSortedProfiles();
    const style = resolveSelectionStyle(selected, sorted, offered);
    return { profile: style.profile, departures: new Set(style.departures) };
    // `profiles` is what getSortedProfiles reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, profiles, offered]);
}

export function ProfileDeparturesProvider({ children }: { children: ReactNode }) {
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const shapes = useDocumentStore((state) => state.shapes);
  const updateShape = useDocumentStore((state) => state.updateShape);
  const push = useHistoryStore((state) => state.push);

  const selected = useMemo(
    () => Array.from(selectedIds).map((id) => shapes[id]).filter((shape): shape is Shape => shape !== undefined),
    [selectedIds, shapes],
  );

  const { profile, departures } = useSelectionStyle(selected);

  const reset = useCallback(
    (name?: string) => {
      if (!profile) return;
      push('Reset to style profile');
      for (const shape of selected) {
        const updates = name
          ? getProfilePropertyUpdate(profile, shape, name)
          : { ...getProfileUpdates(profile, shape), styleProfileId: profile.id };
        updateShape(shape.id, updates as Partial<Shape>);
      }
    },
    [profile, selected, push, updateShape],
  );

  const [marked, setMarked] = useState<string[]>([]);
  const mark = useCallback((name: string) => {
    setMarked((rows) => [...rows, name]);
    return () => setMarked((rows) => rows.filter((_, index) => index !== rows.indexOf(name)));
  }, []);
  const changes = useMemo(() => new Set(marked).size, [marked]);

  const value = useMemo(
    () => ({ profile, departures, changes, mark, reset }),
    [profile, departures, changes, mark, reset],
  );
  return <ProfileDeparturesContext.Provider value={value}>{children}</ProfileDeparturesContext.Provider>;
}

/** `customProperties.rowBackgroundColor` as words: row background color. */
const inWords = (name: string) =>
  name
    .replace(/^customProperties\./, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/ Id$/, '')
    .toLowerCase();

/**
 * A row of the panel for property `name`, marked while it differs from the profile.
 * `tall` is for a row of several lines: the mark stays with the first.
 */
export function ProfileProp({ name, tall, children }: { name: string; tall?: boolean; children: ReactNode }) {
  const { profile, departures, mark, reset } = useProfileDepartures();
  const departed = departures.has(name);
  useLayoutEffect(() => (departed ? mark(name) : undefined), [departed, name, mark]);
  const label = `Reset ${inWords(name)} to ${profile?.name}`;
  return (
    <div className={`profile-prop${departed ? ' profile-prop--departed' : ''}${tall ? ' profile-prop--tall' : ''}`}>
      {children}
      {departed && (
        <button
          type="button"
          className="profile-prop-reset"
          onClick={(event) => {
            // The button goes with the difference. From the keyboard, stay on the row.
            const row = event.currentTarget.closest('.profile-prop');
            reset(name);
            if (event.detail > 0) return;
            const control = row?.querySelector<HTMLElement>('input, select');
            (control ?? row?.querySelector<HTMLElement>('button:not(.profile-prop-reset)'))?.focus();
          }}
          aria-label={label}
          {...tip(label, undefined, 'This differs from the style profile.')}
        >
          <RotateCcw size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
