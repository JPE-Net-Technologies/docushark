/**
 * Actions for the Style Profile panel — apply, save/update/reset, duplicate,
 * delete, rename, favorite, and the collab-safe live preview.
 *
 * Keeping these out of the panel component centralizes the profile↔shape logic
 * (and the JP-399 Update=merge vs Reset=replace distinction) and keeps the panel
 * focused on layout/state.
 */

import { useCallback, useMemo } from 'react';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  useStyleProfileStore,
  extractStyleFromShape,
  getProfileUpdates,
  getApplicablePropertyNames,
  mergeProfileProperties,
  type StyleProfile,
  type ExtractStyleOptions,
} from '../../store/styleProfileStore';
import { confirmDialog } from '../confirm/confirmStore';
import { pushStyleProfiles, pullStyleProfiles } from '../../store/styleProfileSync';
import { isCloudSignedIn } from '../../store/relayDocumentStore';
import { useNotificationStore } from '../../store/notificationStore';
import type { Shape } from '../../shapes/Shape';

export function useProfileActions(selectedShapes: Shape[]) {
  const updateShape = useDocumentStore((s) => s.updateShape);
  const push = useHistoryStore((s) => s.push);
  const addProfile = useStyleProfileStore((s) => s.addProfile);
  const updateProfile = useStyleProfileStore((s) => s.updateProfile);
  const deleteProfile = useStyleProfileStore((s) => s.deleteProfile);
  const renameProfile = useStyleProfileStore((s) => s.renameProfile);
  const toggleFavorite = useStyleProfileStore((s) => s.toggleFavorite);
  const getProfile = useStyleProfileStore((s) => s.getProfile);
  const setStylePreview = useSessionStore((s) => s.setStylePreview);
  const clearStylePreview = useSessionStore((s) => s.clearStylePreview);
  const saveIconStyleToProfile = useSettingsStore((s) => s.saveIconStyleToProfile);
  const saveLabelStyleToProfile = useSettingsStore((s) => s.saveLabelStyleToProfile);

  const firstShape = selectedShapes[0];
  const hasSelection = selectedShapes.length > 0;

  const extractOptions = useMemo<ExtractStyleOptions>(
    () => ({ includeIconStyle: saveIconStyleToProfile, includeLabelStyle: saveLabelStyleToProfile }),
    [saveIconStyleToProfile, saveLabelStyleToProfile]
  );

  /** Style dimensions a profile can affect on the current selection (for the hint tooltip). */
  const applicableNames = useMemo(
    () => (firstShape ? getApplicablePropertyNames(firstShape.type) : []),
    [firstShape]
  );

  const applyProfile = useCallback(
    (profile: StyleProfile) => {
      if (selectedShapes.length === 0) return;
      clearStylePreview();
      push('Apply style profile');
      for (const shape of selectedShapes) {
        updateShape(shape.id, getProfileUpdates(profile, shape));
      }
    },
    [selectedShapes, push, updateShape, clearStylePreview]
  );

  /** Live, collab-safe preview: render-only overrides, never the document. */
  const previewProfile = useCallback(
    (profile: StyleProfile) => {
      if (selectedShapes.length === 0) return;
      const overrides: Record<string, Partial<Shape>> = {};
      for (const shape of selectedShapes) {
        overrides[shape.id] = getProfileUpdates(profile, shape);
      }
      setStylePreview(overrides);
    },
    [selectedShapes, setStylePreview]
  );

  const endPreview = useCallback(() => clearStylePreview(), [clearStylePreview]);

  const saveNewProfile = useCallback(
    (name: string) => {
      if (!firstShape || !name.trim()) return;
      addProfile(name.trim(), extractStyleFromShape(firstShape, extractOptions));
    },
    [firstShape, addProfile, extractOptions]
  );

  /**
   * Push after mutating a profile that lives in the workspace, so an edit isn't
   * silently local-only. A no-op for local profiles — the whole point of the
   * scope split is that they never touch the network.
   */
  const pushIfSynced = useCallback((profileId: string) => {
    if (getProfile(profileId)?.scope === 'workspace') void pushStyleProfiles();
  }, [getProfile]);

  /** Update = non-destructive merge into the existing profile (master memory). */
  const updateProfileFromShape = useCallback(
    (profileId: string) => {
      if (!firstShape) return;
      const existing = getProfile(profileId);
      const extracted = extractStyleFromShape(firstShape, extractOptions);
      updateProfile(profileId, {
        properties: existing ? mergeProfileProperties(existing.properties, extracted) : extracted,
      });
      pushIfSynced(profileId);
    },
    [firstShape, getProfile, updateProfile, extractOptions, pushIfSynced]
  );

  /** Reset = replace the profile from this shape (counterpart to Update/merge). */
  const resetProfileFromShape = useCallback(
    async (profile: StyleProfile) => {
      if (!firstShape) return;
      const ok = await confirmDialog({
        title: `Reset "${profile.name}"?`,
        message: "Replace this profile entirely with the selected shape's current style.",
        details: 'Unlike Update, this discards any styles previously saved into the profile from other shapes.',
        confirmLabel: 'Reset',
      });
      if (!ok) return;
      updateProfile(profile.id, { properties: extractStyleFromShape(firstShape, extractOptions) });
      pushIfSynced(profile.id);
    },
    [firstShape, updateProfile, extractOptions, pushIfSynced]
  );

  const duplicateProfile = useCallback(
    (profile: StyleProfile) => {
      addProfile(`${profile.name} copy`, { ...profile.properties });
    },
    [addProfile]
  );

  const deleteProfileById = useCallback(
    async (profile: StyleProfile) => {
      const ok = await confirmDialog({
        title: `Delete "${profile.name}"?`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const wasSynced = profile.scope === 'workspace';
      deleteProfile(profile.id);
      // A deleted workspace profile has to leave the registry too, or the next
      // device to sign in pulls it straight back.
      if (wasSynced) void pushStyleProfiles();
    },
    [deleteProfile]
  );

  /**
   * Move a profile between this device and the workspace (JP-301).
   *
   * Promoting uploads it so other signed-in devices get it. Demoting removes it
   * from the workspace *everywhere*, so it confirms first — the profile stays on
   * this device, but a colleague's copy disappears, and that is not obvious from
   * a menu item alone.
   */
  const setProfileScope = useCallback(
    async (profile: StyleProfile, scope: 'local' | 'workspace') => {
      if (scope === 'local') {
        const ok = await confirmDialog({
          title: `Stop syncing "${profile.name}"?`,
          message: 'It stays on this device and is removed from the workspace.',
          details: 'Anyone else signed into this workspace will lose their copy.',
          confirmLabel: 'Stop syncing',
        });
        if (!ok) return;
      }
      useStyleProfileStore.getState().setProfileScope(profile.id, scope);
      await pushStyleProfiles();
    },
    []
  );

  /** Pull the workspace's registry on demand — sync is manual by design. */
  const refreshFromWorkspace = useCallback(async () => {
    const count = await pullStyleProfiles();
    useNotificationStore
      .getState()
      .success(
        count === 0
          ? 'No style profiles saved to this workspace yet.'
          : `Refreshed ${count} workspace style profile${count === 1 ? '' : 's'}.`,
      );
  }, []);

  return {
    firstShape,
    hasSelection,
    applicableNames,
    /** Whether workspace sync is available at all (signed in to Cloud). */
    canSync: isCloudSignedIn(),
    setProfileScope,
    refreshFromWorkspace,
    applyProfile,
    previewProfile,
    endPreview,
    saveNewProfile,
    updateProfileFromShape,
    resetProfileFromShape,
    duplicateProfile,
    deleteProfileById,
    renameProfile: (id: string, name: string) => {
      renameProfile(id, name);
      pushIfSynced(id);
    },
    toggleFavorite,
  };
}
