/**
 * Save to Library Dialog - Modal for saving shapes to a custom library.
 *
 * Features:
 * - Shape preview thumbnail
 * - Name input
 * - Library selection dropdown
 * - Create new library option
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useCustomShapeLibraryStore, initializeCustomShapeLibrary } from '../store/customShapeLibraryStore';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { Boxes, Square } from 'lucide-react';
import { Icon } from './icons';
import { generateThumbnail } from '../utils/shapeSerializer';
import type { Shape } from '../shapes/Shape';
import './SaveToLibraryDialog.css';

export interface SaveToLibraryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SaveToLibraryDialog({ isOpen, onClose }: SaveToLibraryDialogProps) {
  const [name, setName] = useState('');
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [isCreatingLibrary, setIsCreatingLibrary] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shapes = useDocumentStore((s) => s.shapes);
  const selectedIds = useSessionStore((s) => s.selectedIds);

  const {
    libraries,
    isInitialized,
    createLibrary,
    saveToLibrary,
  } = useCustomShapeLibraryStore();

  // Initialize on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeCustomShapeLibrary();
    }
  }, [isInitialized]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
      setIsCreatingLibrary(false);
      setNewLibraryName('');
      // Select first library if available and none selected
      if (libraries.length > 0 && !selectedLibraryId) {
        setSelectedLibraryId(libraries[0]!.id);
      }
    }
  }, [isOpen, libraries, selectedLibraryId]);

  // Get selected shapes
  const selectedShapes = useMemo(() => {
    return Array.from(selectedIds)
      .map((id) => shapes[id])
      .filter((s): s is Shape => s !== undefined);
  }, [selectedIds, shapes]);

  // Generate thumbnail preview
  const thumbnail = useMemo(() => {
    if (selectedShapes.length === 0) return '';
    return generateThumbnail(selectedShapes, shapes, 120);
  }, [selectedShapes, shapes]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle create new library
  const handleCreateLibrary = useCallback(() => {
    if (!newLibraryName.trim()) return;

    const newId = createLibrary(newLibraryName.trim());
    setSelectedLibraryId(newId);
    setIsCreatingLibrary(false);
    setNewLibraryName('');
  }, [newLibraryName, createLibrary]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }

    if (!selectedLibraryId) {
      setError('Please select a library');
      return;
    }

    setError(null);
    setIsSaving(true);

    try {
      const result = await saveToLibrary(
        selectedLibraryId,
        name.trim(),
        Array.from(selectedIds),
        shapes
      );

      if (!result.success) {
        setError(result.error || 'Failed to save');
        setIsSaving(false);
        return;
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  }, [name, selectedLibraryId, selectedIds, shapes, saveToLibrary, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  const shapeCount = selectedShapes.length;
  const isGroup = shapeCount > 1;

  return (
    <div className="save-to-library-overlay" onClick={handleOverlayClick}>
      <div className="save-to-library-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="save-to-library-header">
          <h2>Save to Library</h2>
          <button className="save-to-library-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="save-to-library-content">
          {/* Preview */}
          <div className="save-to-library-preview">
            {thumbnail ? (
              <img src={thumbnail} alt="Shape preview" />
            ) : (
              <div className="save-to-library-preview-placeholder">
                {isGroup ? <Icon icon={Boxes} size={28} /> : <Icon icon={Square} size={28} />}
              </div>
            )}
            <span className="save-to-library-preview-info">
              {shapeCount} {shapeCount === 1 ? 'shape' : 'shapes'}
              {isGroup && ' (will be saved as group)'}
            </span>
          </div>

          {/* Name input */}
          <div className="save-to-library-field">
            <label className="save-to-library-label">Name</label>
            <input
              type="text"
              className="save-to-library-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a name for this shape"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && selectedLibraryId) {
                  handleSave();
                }
              }}
            />
          </div>

          {/* Library selection */}
          <div className="save-to-library-field">
            <label className="save-to-library-label">Library</label>
            {isCreatingLibrary ? (
              <div className="save-to-library-create-library">
                <input
                  type="text"
                  className="save-to-library-input"
                  value={newLibraryName}
                  onChange={(e) => setNewLibraryName(e.target.value)}
                  placeholder="New library name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateLibrary();
                    if (e.key === 'Escape') {
                      setIsCreatingLibrary(false);
                      setNewLibraryName('');
                    }
                  }}
                />
                <button
                  className="save-to-library-create-btn"
                  onClick={handleCreateLibrary}
                  disabled={!newLibraryName.trim()}
                >
                  Create
                </button>
                <button
                  className="save-to-library-cancel-btn"
                  onClick={() => {
                    setIsCreatingLibrary(false);
                    setNewLibraryName('');
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="save-to-library-select-container">
                <select
                  className="save-to-library-select"
                  value={selectedLibraryId || ''}
                  onChange={(e) => setSelectedLibraryId(e.target.value || null)}
                >
                  {libraries.length === 0 ? (
                    <option value="">No libraries - create one first</option>
                  ) : (
                    <>
                      <option value="">Select a library...</option>
                      {libraries.map((lib) => (
                        <option key={lib.id} value={lib.id}>
                          {lib.name} ({lib.itemCount} items)
                        </option>
                      ))}
                    </>
                  )}
                </select>
                <button
                  className="save-to-library-new-library-btn"
                  onClick={() => setIsCreatingLibrary(true)}
                  title="Create new library"
                >
                  +
                </button>
              </div>
            )}
          </div>

          {/* Error message */}
          {error && <div className="save-to-library-error">{error}</div>}
        </div>

        <div className="save-to-library-footer">
          <button className="save-to-library-btn save-to-library-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="save-to-library-btn save-to-library-btn-primary"
            onClick={handleSave}
            disabled={isSaving || !name.trim() || !selectedLibraryId}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SaveToLibraryDialog;
