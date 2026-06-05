/**
 * Shape Library Manager - UI for managing custom shape libraries.
 *
 * Features:
 * - List and select libraries
 * - Create, rename, delete libraries
 * - Import/export libraries
 * - View and manage library items
 * - Delete and rename items
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, Upload, Download, Pencil, Trash2, Boxes, Square } from 'lucide-react';
import { useCustomShapeLibraryStore, initializeCustomShapeLibrary } from '../store/customShapeLibraryStore';
import type { CustomShapeLibrary, CustomShapeItem } from '../storage/ShapeLibraryTypes';
import { Icon } from './icons';
import './ShapeLibraryManager.css';

/**
 * ShapeLibraryManager component.
 */
export function ShapeLibraryManager() {
  const [isCreating, setIsCreating] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState('');
  const [editingLibraryId, setEditingLibraryId] = useState<string | null>(null);
  const [editingLibraryName, setEditingLibraryName] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemName, setEditingItemName] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const {
    libraries,
    selectedLibraryId,
    isLoading,
    isInitialized,
    error,
    createLibrary,
    renameLibrary,
    deleteLibrary,
    selectLibrary,
    getLibraryItems,
    deleteItem,
    renameItem,
    exportLibrary,
    importLibrary,
    clearError,
  } = useCustomShapeLibraryStore();

  // Initialize on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeCustomShapeLibrary();
    }
  }, [isInitialized]);

  // Focus create input when creating
  useEffect(() => {
    if (isCreating && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [isCreating]);

  // Get items for selected library
  const selectedLibrary = libraries.find((lib) => lib.id === selectedLibraryId);
  const libraryItems = selectedLibraryId ? getLibraryItems(selectedLibraryId) : [];

  // Create new library
  const handleCreateLibrary = useCallback(() => {
    if (!newLibraryName.trim()) return;

    createLibrary(newLibraryName.trim());
    setNewLibraryName('');
    setIsCreating(false);
  }, [newLibraryName, createLibrary]);

  // Start editing library name
  const handleStartEditLibrary = useCallback((library: CustomShapeLibrary) => {
    setEditingLibraryId(library.id);
    setEditingLibraryName(library.name);
  }, []);

  // Save library name
  const handleSaveLibraryName = useCallback(() => {
    if (!editingLibraryId || !editingLibraryName.trim()) return;

    renameLibrary(editingLibraryId, editingLibraryName.trim());
    setEditingLibraryId(null);
    setEditingLibraryName('');
  }, [editingLibraryId, editingLibraryName, renameLibrary]);

  // Delete library
  const handleDeleteLibrary = useCallback(
    async (library: CustomShapeLibrary) => {
      if (!confirm(`Delete library "${library.name}"? This will delete all items in the library.`)) {
        return;
      }

      await deleteLibrary(library.id);
    },
    [deleteLibrary]
  );

  // Export library
  const handleExportLibrary = useCallback(
    async (library: CustomShapeLibrary) => {
      const blob = await exportLibrary(library.id);
      if (!blob) return;

      // Download the file
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${library.name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [exportLibrary]
  );

  // Import library
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const result = await importLibrary(file);
      if (!result.success) {
        alert(`Import failed: ${result.error}`);
      }

      // Reset input
      e.target.value = '';
    },
    [importLibrary]
  );

  // Start editing item name
  const handleStartEditItem = useCallback((item: CustomShapeItem) => {
    setEditingItemId(item.id);
    setEditingItemName(item.name);
  }, []);

  // Save item name
  const handleSaveItemName = useCallback(async () => {
    if (!editingItemId || !editingItemName.trim()) return;

    await renameItem(editingItemId, editingItemName.trim());
    setEditingItemId(null);
    setEditingItemName('');
  }, [editingItemId, editingItemName, renameItem]);

  // Delete item
  const handleDeleteItem = useCallback(
    async (item: CustomShapeItem) => {
      if (!confirm(`Delete "${item.name}"?`)) {
        return;
      }

      await deleteItem(item.id);
    },
    [deleteItem]
  );

  if (isLoading) {
    return (
      <div className="shape-library-manager">
        <div className="shape-library-loading">Loading libraries...</div>
      </div>
    );
  }

  return (
    <div className="shape-library-manager">
      {/* Error message */}
      {error && (
        <div className="shape-library-error">
          {error}
          <button className="shape-library-error-dismiss" onClick={clearError}>
            ×
          </button>
        </div>
      )}

      <div className="shape-library-layout">
        {/* Library list sidebar */}
        <div className="shape-library-sidebar">
          <div className="shape-library-sidebar-header">
            <h3>Libraries</h3>
            <div className="shape-library-sidebar-actions">
              <button
                className="shape-library-action-btn"
                onClick={() => setIsCreating(true)}
                title="Create library"
              >
                <Icon icon={Plus} />
              </button>
              <button
                className="shape-library-action-btn"
                onClick={handleImportClick}
                title="Import library"
              >
                <Icon icon={Upload} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </div>
          </div>

          {/* Create new library input */}
          {isCreating && (
            <div className="shape-library-create-form">
              <input
                ref={createInputRef}
                type="text"
                className="shape-library-create-input"
                placeholder="Library name"
                value={newLibraryName}
                onChange={(e) => setNewLibraryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateLibrary();
                  if (e.key === 'Escape') {
                    setIsCreating(false);
                    setNewLibraryName('');
                  }
                }}
              />
              <button
                className="shape-library-create-btn"
                onClick={handleCreateLibrary}
                disabled={!newLibraryName.trim()}
              >
                Create
              </button>
              <button
                className="shape-library-cancel-btn"
                onClick={() => {
                  setIsCreating(false);
                  setNewLibraryName('');
                }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Library list */}
          <div className="shape-library-list">
            {libraries.length === 0 ? (
              <div className="shape-library-empty">
                No libraries yet. Create one to start saving shapes.
              </div>
            ) : (
              libraries.map((library) => (
                <div
                  key={library.id}
                  className={`shape-library-item ${selectedLibraryId === library.id ? 'selected' : ''}`}
                  onClick={() => selectLibrary(library.id)}
                >
                  {editingLibraryId === library.id ? (
                    <input
                      type="text"
                      className="shape-library-edit-input"
                      value={editingLibraryName}
                      onChange={(e) => setEditingLibraryName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveLibraryName();
                        if (e.key === 'Escape') {
                          setEditingLibraryId(null);
                          setEditingLibraryName('');
                        }
                      }}
                      onBlur={handleSaveLibraryName}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="shape-library-item-name">{library.name}</span>
                      <span className="shape-library-item-count">{library.itemCount}</span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Library content */}
        <div className="shape-library-content">
          {selectedLibrary ? (
            <>
              <div className="shape-library-content-header">
                <h3>{selectedLibrary.name}</h3>
                <div className="shape-library-content-actions">
                  <button
                    className="shape-library-action-btn"
                    onClick={() => handleStartEditLibrary(selectedLibrary)}
                    title="Rename library"
                  >
                    <Icon icon={Pencil} />
                  </button>
                  <button
                    className="shape-library-action-btn"
                    onClick={() => handleExportLibrary(selectedLibrary)}
                    title="Export library"
                  >
                    <Icon icon={Download} />
                  </button>
                  <button
                    className="shape-library-action-btn danger"
                    onClick={() => handleDeleteLibrary(selectedLibrary)}
                    title="Delete library"
                  >
                    <Icon icon={Trash2} />
                  </button>
                </div>
              </div>

              {libraryItems.length === 0 ? (
                <div className="shape-library-items-empty">
                  <p>No shapes in this library.</p>
                  <p className="shape-library-items-hint">
                    Right-click on shapes in the canvas and select "Save to Library" to add them here.
                  </p>
                </div>
              ) : (
                <div className="shape-library-items-grid">
                  {libraryItems.map((item) => (
                    <div key={item.id} className="shape-library-shape-item">
                      <div className="shape-library-shape-preview">
                        {item.thumbnail ? (
                          <img src={item.thumbnail} alt={item.name} />
                        ) : (
                          <div className="shape-library-shape-placeholder">
                            {item.type === 'group' ? <Icon icon={Boxes} size={28} /> : <Icon icon={Square} size={28} />}
                          </div>
                        )}
                      </div>
                      {editingItemId === item.id ? (
                        <input
                          type="text"
                          className="shape-library-shape-edit-input"
                          value={editingItemName}
                          onChange={(e) => setEditingItemName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveItemName();
                            if (e.key === 'Escape') {
                              setEditingItemId(null);
                              setEditingItemName('');
                            }
                          }}
                          onBlur={handleSaveItemName}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="shape-library-shape-name"
                          onDoubleClick={() => handleStartEditItem(item)}
                          title={item.name}
                        >
                          {item.name}
                        </span>
                      )}
                      <div className="shape-library-shape-actions">
                        <button
                          className="shape-library-shape-action-btn"
                          onClick={() => handleStartEditItem(item)}
                          title="Rename"
                        >
                          <Icon icon={Pencil} />
                        </button>
                        <button
                          className="shape-library-shape-action-btn danger"
                          onClick={() => handleDeleteItem(item)}
                          title="Delete"
                        >
                          <Icon icon={Trash2} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="shape-library-no-selection">
              <p>Select a library to view its contents</p>
              <p className="shape-library-no-selection-hint">
                Or create a new library using the + button
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShapeLibraryManager;
