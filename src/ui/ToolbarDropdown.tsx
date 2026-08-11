/**
 * ToolbarDropdown - Portal-based dropdown for toolbar buttons.
 *
 * Uses React Portal to render dropdown content at document body level,
 * avoiding z-index and overflow clipping issues.
 *
 * Features:
 * - Portal-based rendering
 * - Auto-positioning relative to trigger
 * - Click-outside to close
 * - Scroll/resize repositioning
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ToolbarDropdown.css';

interface ToolbarDropdownProps {
  /** Trigger button content */
  trigger: ReactNode;
  /** Dropdown content */
  children: ReactNode;
  /** Whether dropdown is open (controlled) */
  isOpen: boolean;
  /** Callback to toggle open state */
  onToggle: () => void;
  /** Callback when dropdown should close */
  onClose: () => void;
  /** CSS class for trigger button */
  triggerClassName?: string;
  /** Title/tooltip for trigger button */
  title?: string;
  /** Whether trigger is in active state */
  isActive?: boolean;
  /** Alignment of dropdown relative to trigger */
  align?: 'left' | 'right';
}

interface DropdownPosition {
  top: number;
  left: number;
}

export function ToolbarDropdown({
  trigger,
  children,
  isOpen,
  onToggle,
  onClose,
  triggerClassName = '',
  title,
  isActive = false,
  align = 'left',
}: ToolbarDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<DropdownPosition>({ top: 0, left: 0 });

  // Calculate dropdown position
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    
    const rect = triggerRef.current.getBoundingClientRect();
    const dropdownWidth = dropdownRef.current?.offsetWidth ?? 200;
    
    let left = rect.left;
    if (align === 'right') {
      left = rect.right - dropdownWidth;
    }
    
    // Ensure dropdown doesn't go off-screen
    const maxLeft = window.innerWidth - dropdownWidth - 8;
    left = Math.max(8, Math.min(left, maxLeft));
    
    setPosition({
      top: rect.bottom + 4,
      left,
    });
  }, [align]);

  // Update position when opening
  useEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isOpen) return;

    const handleUpdate = () => updatePosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);
    
    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isOpen, updatePosition]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        onClose();
      }
    };

    // Use timeout to avoid closing on the same click that opens
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`${triggerClassName} ${isActive ? 'active' : ''}`}
        onClick={onToggle}
        title={title}
        type="button"
      >
        {trigger}
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="toolbar-dropdown-portal"
            style={{ top: position.top, left: position.left }}
            onMouseDown={(e) => {
              // Suppressing the default keeps the editor's selection alive
              // while a control in here is clicked, so a toolbar action still
              // applies to the text the user had selected.
              //
              // It must not apply to a focusable field, though: blocking the
              // default also blocks focus, so an input inside a dropdown could
              // never be typed into — the caret stays in the document and the
              // keystrokes go there instead. Harmless while these dropdowns
              // held only buttons; not once the shared colour picker put a hex
              // field in one.
              const target = e.target as HTMLElement | null;
              if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
              e.preventDefault();
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
