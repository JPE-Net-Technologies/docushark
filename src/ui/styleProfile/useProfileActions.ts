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

  /** Update = non-destructive merge into the existing profile (master memory). */
  const updateProfileFromShape = useCallback(
    (profileId: string) => {
      if (!firstShape) return;
      const existing = getProfile(profileId);
      const extracted = extractStyleFromShape(firstShape, extractOptions);
      updateProfile(profileId, {
        properties: existing ? mergeProfileProperties(existing.properties, extracted) : extracted,
      });
    },
    [firstShape, getProfile, updateProfile, extractOptions]
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
    },
    [firstShape, updateProfile, extractOptions]
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
      if (ok) deleteProfile(profile.id);
    },
    [deleteProfile]
  );

  return {
    firstShape,
    hasSelection,
    applicableNames,
    applyProfile,
    previewProfile,
    endPreview,
    saveNewProfile,
    updateProfileFromShape,
    resetProfileFromShape,
    duplicateProfile,
    deleteProfileById,
    renameProfile,
    toggleFavorite,
  };
}
