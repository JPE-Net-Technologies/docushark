import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { isGroup, isConnector, isFile, RoutingMode, GroupShape } from '../shapes/Shape';
import { replaceFileContents } from '../services/FileReplaceService';
import { nanoid } from 'nanoid';
import './ContextMenu.css';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onExport?: () => void;
  onSaveToLibrary?: () => void;
}

interface SubmenuItem {
  label: string;
  onClick: () => void;
  checked?: boolean;
  disabled?: boolean;
}

interface SubmenuProps {
  label: string;
  items: SubmenuItem[];
  onClose: () => void;
}

/**
 * Submenu component for nested menu options.
 */
function Submenu({ label, items, onClose }: SubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsOpen(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 150);
  }, []);

  const handleItemClick = useCallback((item: SubmenuItem) => {
    if (!item.disabled) {
      item.onClick();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="context-menu-submenu"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="context-menu-item has-submenu">
        <span className="context-menu-label">{label}</span>
        <span className="context-menu-arrow">▶</span>
      </div>
      {isOpen && (
        <div className="context-menu-submenu-content">
          {items.map((item, index) => (
            <button
              key={index}
              className={`context-menu-item ${item.disabled ? 'disabled' : ''}`}
              onClick={() => handleItemClick(item)}
            >
              <span className="context-menu-check">
                {item.checked ? '✓' : ''}
              </span>
              <span className="context-menu-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Context menu for shape operations.
 * Shows contextual actions based on current selection.
 */
export function ContextMenu({ x, y, onClose, onExport, onSaveToLibrary }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const shapes = useDocumentStore((state) => state.shapes);
  const updateShape = useDocumentStore((state) => state.updateShape);
  const select = useSessionStore((state) => state.select);
  const clearSelection = useSessionStore((state) => state.clearSelection);
  const groupShapes = useDocumentStore((state) => state.groupShapes);
  const ungroupShape = useDocumentStore((state) => state.ungroupShape);
  const deleteShapes = useDocumentStore((state) => state.deleteShapes);
  const bringToFrontMultiple = useDocumentStore((state) => state.bringToFrontMultiple);
  const sendToBackMultiple = useDocumentStore((state) => state.sendToBackMultiple);
  const getParentGroup = useDocumentStore((state) => state.getParentGroup);
  const moveShapeInHierarchy = useDocumentStore((state) => state.moveShapeInHierarchy);
  const push = useHistoryStore((state) => state.push);

  const selectedArray = Array.from(selectedIds);
  const hasSelection = selectedArray.length > 0;
  const canGroup = selectedArray.length >= 2;

  // Get selected shapes
  const selectedShapes = selectedArray.map(id => shapes[id]).filter(Boolean);
  const firstShape = selectedShapes[0];

  // Check if a single group is selected
  const singleGroupSelected = selectedArray.length === 1 &&
    firstShape && isGroup(firstShape);

  // Check if a connector is selected (for routing options)
  const hasConnector = selectedShapes.some(s => s && isConnector(s));
  const singleConnector = selectedShapes.length === 1 && firstShape && isConnector(firstShape);
  const connectorRoutingMode = singleConnector && isConnector(firstShape) ? firstShape.routingMode : undefined;

  // Check if a single FileShape is selected (for replace option)
  const singleFileSelected = selectedShapes.length === 1 && firstShape && isFile(firstShape);

  // File input ref for replace
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isReplacing, setIsReplacing] = useState(false);

  // Check lock states
  const allLocked = selectedShapes.every(s => s?.locked);
  const allPositionLocked = selectedShapes.every(s => s?.lockedPosition);
  const allSizeLocked = selectedShapes.every(s => s?.lockedSize);

  // Check if any selected shape is inside a group
  const selectedInGroup = useMemo(() => {
    return selectedArray.some(id => getParentGroup(id) !== null);
  }, [selectedArray, getParentGroup]);

  // Get all groups in the document for "Add to Group" submenu
  const availableGroups = useMemo(() => {
    const allGroups = Object.values(shapes).filter(s => isGroup(s)) as GroupShape[];
    // Filter out:
    // 1. Groups that are currently selected (can't add to itself)
    // 2. Groups that are descendants of selected shapes (would create cycle)
    return allGroups.filter(group => {
      // Can't add a shape to itself
      if (selectedArray.includes(group.id)) return false;

      // Check for cycles: can't add a group to its own descendant
      // (if any selected shape is an ancestor of this group)
      const isDescendant = (groupId: string, potentialAncestorIds: string[]): boolean => {
        for (const id of potentialAncestorIds) {
          const shape = shapes[id];
          if (shape && isGroup(shape)) {
            if (shape.childIds.includes(groupId)) return true;
            // Recursively check children
            for (const childId of shape.childIds) {
              const child = shapes[childId];
              if (child && isGroup(child)) {
                if (isDescendant(groupId, [childId])) return true;
              }
            }
          }
        }
        return false;
      };

      return !isDescendant(group.id, selectedArray);
    });
  }, [shapes, selectedArray]);

  // Adjust position to keep menu within viewport
  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8;

    let newX = x;
    let newY = y;

    // Check if menu overflows right edge
    if (x + rect.width > viewportWidth - padding) {
      newX = Math.max(padding, viewportWidth - rect.width - padding);
    }

    // Check if menu overflows bottom edge
    if (y + rect.height > viewportHeight - padding) {
      newY = Math.max(padding, viewportHeight - rect.height - padding);
    }

    // Check left edge
    if (newX < padding) {
      newX = padding;
    }

    // Check top edge
    if (newY < padding) {
      newY = padding;
    }

    if (newX !== adjustedPosition.x || newY !== adjustedPosition.y) {
      setAdjustedPosition({ x: newX, y: newY });
    }
  }, [x, y, adjustedPosition.x, adjustedPosition.y]);

  // Close menu on click outside or escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu
      const target = e.target as Element;
      if (target.closest('.context-menu')) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Use setTimeout to avoid immediate close from the right-click event
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleGroup = useCallback(() => {
    if (canGroup) {
      push('Group shapes');
      const groupId = nanoid();
      groupShapes(selectedArray, groupId);
      select([groupId]);
    }
    onClose();
  }, [canGroup, selectedArray, push, groupShapes, select, onClose]);

  const handleUngroup = useCallback(() => {
    if (singleGroupSelected && firstShape && isGroup(firstShape)) {
      push('Ungroup shapes');
      const childIds = [...firstShape.childIds];
      ungroupShape(firstShape.id);
      select(childIds);
    }
    onClose();
  }, [singleGroupSelected, firstShape, push, ungroupShape, select, onClose]);

  const handleDelete = useCallback(() => {
    if (hasSelection) {
      push('Delete shapes');
      deleteShapes(selectedArray);
      clearSelection();
    }
    onClose();
  }, [hasSelection, selectedArray, push, deleteShapes, clearSelection, onClose]);

  const handleBringToFront = useCallback(() => {
    if (hasSelection) {
      push('Bring to front');
      bringToFrontMultiple(selectedArray);
    }
    onClose();
  }, [hasSelection, selectedArray, push, bringToFrontMultiple, onClose]);

  const handleSendToBack = useCallback(() => {
    if (hasSelection) {
      push('Send to back');
      sendToBackMultiple(selectedArray);
    }
    onClose();
  }, [hasSelection, selectedArray, push, sendToBackMultiple, onClose]);

  const handleExport = useCallback(() => {
    if (hasSelection && onExport) {
      onExport();
    }
    onClose();
  }, [hasSelection, onExport, onClose]);

  const handleSaveToLibrary = useCallback(() => {
    if (hasSelection && onSaveToLibrary) {
      onSaveToLibrary();
    }
    onClose();
  }, [hasSelection, onSaveToLibrary, onClose]);

  // Routing submenu items
  const routingItems: SubmenuItem[] = [
    {
      label: 'Straight',
      checked: connectorRoutingMode === 'straight',
      onClick: () => {
        push('Change routing mode');
        selectedShapes.forEach(s => {
          if (s && isConnector(s)) {
            updateShape(s.id, { routingMode: 'straight' as RoutingMode });
          }
        });
      },
    },
    {
      label: 'Orthogonal',
      checked: connectorRoutingMode === 'orthogonal',
      onClick: () => {
        push('Change routing mode');
        selectedShapes.forEach(s => {
          if (s && isConnector(s)) {
            updateShape(s.id, { routingMode: 'orthogonal' as RoutingMode });
          }
        });
      },
    },
  ];

  // Lock submenu items
  const lockItems: SubmenuItem[] = [
    {
      label: 'Lock Position',
      checked: allPositionLocked,
      onClick: () => {
        push(allPositionLocked ? 'Unlock position' : 'Lock position');
        selectedShapes.forEach(s => {
          if (s) {
            updateShape(s.id, { lockedPosition: !allPositionLocked });
          }
        });
      },
    },
    {
      label: 'Lock Size',
      checked: allSizeLocked,
      onClick: () => {
        push(allSizeLocked ? 'Unlock size' : 'Lock size');
        selectedShapes.forEach(s => {
          if (s) {
            updateShape(s.id, { lockedSize: !allSizeLocked });
          }
        });
      },
    },
    {
      label: 'Lock All',
      checked: allLocked,
      onClick: () => {
        push(allLocked ? 'Unlock shape' : 'Lock shape');
        selectedShapes.forEach(s => {
          if (s) {
            updateShape(s.id, { locked: !allLocked });
          }
        });
      },
    },
  ];

  // Add to Group submenu items
  const addToGroupItems: SubmenuItem[] = availableGroups.map(group => ({
    label: group.name || `Group ${group.id.slice(0, 6)}`,
    onClick: () => {
      push('Add to group');
      selectedArray.forEach(id => {
        moveShapeInHierarchy(id, group.id, 0);
      });
    },
  }));

  // Handle remove from group
  const handleRemoveFromGroup = useCallback(() => {
    push('Remove from group');
    selectedArray.forEach(id => {
      moveShapeInHierarchy(id, null);
    });
    onClose();
  }, [selectedArray, push, moveShapeInHierarchy, onClose]);

  // Handle replace file
  const handleReplaceFileClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !firstShape) return;

      setIsReplacing(true);
      try {
        await replaceFileContents(firstShape.id, file);
      } finally {
        setIsReplacing(false);
        onClose();
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [firstShape, onClose]
  );

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {canGroup && (
        <button className="context-menu-item" onClick={handleGroup}>
          <span className="context-menu-label">Group</span>
          <span className="context-menu-shortcut">Ctrl+G</span>
        </button>
      )}

      {singleGroupSelected && (
        <button className="context-menu-item" onClick={handleUngroup}>
          <span className="context-menu-label">Ungroup</span>
          <span className="context-menu-shortcut">Ctrl+Shift+G</span>
        </button>
      )}

      {/* Add to Group submenu - show when groups exist and shapes are selected */}
      {hasSelection && availableGroups.length > 0 && (
        <Submenu label="Add to Group" items={addToGroupItems} onClose={onClose} />
      )}

      {/* Remove from Group - show when selected shapes are in a group */}
      {hasSelection && selectedInGroup && (
        <button className="context-menu-item" onClick={handleRemoveFromGroup}>
          <span className="context-menu-label">Remove from Group</span>
        </button>
      )}

      {(canGroup || singleGroupSelected || (hasSelection && availableGroups.length > 0) || selectedInGroup) && hasSelection && (
        <div className="context-menu-separator" />
      )}

      {hasSelection && (
        <>
          <button className="context-menu-item" onClick={handleBringToFront}>
            <span className="context-menu-label">Bring to Front</span>
          </button>
          <button className="context-menu-item" onClick={handleSendToBack}>
            <span className="context-menu-label">Send to Back</span>
          </button>

          <div className="context-menu-separator" />

          {/* Connector Routing submenu */}
          {hasConnector && (
            <Submenu label="Routing" items={routingItems} onClose={onClose} />
          )}

          {/* Lock submenu */}
          <Submenu label="Lock" items={lockItems} onClose={onClose} />

          <div className="context-menu-separator" />

          {onSaveToLibrary && (
            <button className="context-menu-item" onClick={handleSaveToLibrary}>
              <span className="context-menu-label">Save to Library...</span>
            </button>
          )}
          {onExport && (
            <button className="context-menu-item" onClick={handleExport}>
              <span className="context-menu-label">Export Selection...</span>
            </button>
          )}
          {singleFileSelected && (
            <button
              className="context-menu-item"
              onClick={handleReplaceFileClick}
              disabled={isReplacing}
            >
              <span className="context-menu-label">
                {isReplacing ? 'Replacing...' : 'Replace File...'}
              </span>
            </button>
          )}
          {/* Hidden file input for replace */}
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={handleReplaceFile}
          />
          {(onSaveToLibrary || onExport || singleFileSelected) && <div className="context-menu-separator" />}
          <button className="context-menu-item danger" onClick={handleDelete}>
            <span className="context-menu-label">Delete</span>
            <span className="context-menu-shortcut">Del</span>
          </button>
        </>
      )}

      {!hasSelection && (
        <div className="context-menu-item disabled">
          <span className="context-menu-label">No selection</span>
        </div>
      )}
    </div>
  );
}
