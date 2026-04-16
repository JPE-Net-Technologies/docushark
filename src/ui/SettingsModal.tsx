/**
 * Settings modal with tab-based navigation.
 *
 * Features:
 * - Tab infrastructure for multiple settings sections
 * - Documents management (new, open, save, import/export)
 * - General settings (connector defaults, style profile defaults, display options, theme)
 * - Storage management (images and icons)
 * - Style Profile settings
 * - Shape Libraries management
 */

import { useState, useCallback, useEffect } from 'react';
import {
  FileText,
  Settings,
  Users,
  Database,
  Package,
  Palette,
  Library,
} from 'lucide-react';
import { ShapeLibraryManager } from './ShapeLibraryManager';
import { DocumentBrowser } from './settings/DocumentBrowser';
import { GeneralSettings } from './settings/GeneralSettings';
import { StorageSettings } from './settings/StorageSettings';
import { StyleProfileSettings } from './settings/StyleProfileSettings';
import { CollaborationSettings } from './settings/CollaborationSettings';
import { BackupSettings } from './settings/BackupSettings';
import './SettingsModal.css';

/**
 * Available settings tabs.
 */
type SettingsTab = 'documents' | 'general' | 'collaboration' | 'storage' | 'backup' | 'style-profiles' | 'shape-libraries';

/**
 * Tab configuration.
 */
interface TabConfig {
  id: SettingsTab;
  label: string;
  icon: React.ComponentType<Record<string, unknown>>;
}

/**
 * Available tabs configuration.
 */
const TABS: TabConfig[] = [
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'general', label: 'General', icon: Settings },
  { id: 'collaboration', label: 'Collaboration', icon: Users },
  { id: 'storage', label: 'Storage', icon: Database },
  { id: 'backup', label: 'Backup & Restore', icon: Package },
  { id: 'style-profiles', label: 'Style Profiles', icon: Palette },
  { id: 'shape-libraries', label: 'Shape Libraries', icon: Library },
];

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
}

export function SettingsModal({ isOpen, onClose, initialTab = 'documents' }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Reset to initial tab when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

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

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div className="settings-modal-overlay" onClick={handleOverlayClick}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <button className="settings-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Content area with sidebar */}
        <div className="settings-modal-body">
          {/* Tab sidebar */}
          <nav className="settings-modal-sidebar">
            {TABS.map((tab) => {
              const IconComponent = tab.icon;
              return (
                <button
                  key={tab.id}
                  data-tab={tab.id}
                  className={`settings-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="settings-tab-icon">
                    <IconComponent size={18} />
                  </span>
                  <span className="settings-tab-label">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Tab content */}
          <div className="settings-modal-content">
            {activeTab === 'documents' && <DocumentBrowser />}
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'collaboration' && <CollaborationSettings />}
            {activeTab === 'storage' && <StorageSettings />}
            {activeTab === 'backup' && <BackupSettings />}
            {activeTab === 'style-profiles' && <StyleProfileSettings />}
            {activeTab === 'shape-libraries' && <ShapeLibraryManager />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
