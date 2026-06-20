/**
 * Settings modal with tab-based navigation.
 *
 * Features:
 * - Tab infrastructure for multiple settings sections
 * - Documents management (new, open, save, import/export)
 * - General settings (connector defaults, style profile defaults, display options)
 * - Appearance (theme, canvas grid, layout customization, window chrome)
 * - Storage management (images and icons)
 * - Style Profile settings
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Settings,
  Package,
  Palette,
  SwatchBook,
  Info,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { GeneralSettings } from './settings/GeneralSettings';
import { StyleProfileSettings } from './settings/StyleProfileSettings';
import { BackupSettings } from './settings/BackupSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { AboutSettings } from './settings/AboutSettings';
import './SettingsModal.css';

/**
 * Available settings tabs. Documents, Storage, Cloud connection, and the shape
 * library manager moved to the first-class Documents surface (JP-218); Settings
 * is now true preferences.
 */
type SettingsTab = 'general' | 'appearance' | 'style-profiles' | 'backup' | 'about';

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
  { id: 'general', label: 'General', icon: Settings },
  { id: 'appearance', label: 'Appearance', icon: SwatchBook },
  { id: 'style-profiles', label: 'Style Profiles', icon: Palette },
  { id: 'backup', label: 'Backup & Restore', icon: Package },
  { id: 'about', label: 'About', icon: Info },
];

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
}

export function SettingsModal({ isOpen, onClose, initialTab = 'general' }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);

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
      <div
        className={`settings-modal${isFullscreen ? ' is-fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <div className="settings-modal-header-actions">
            <button
              className="settings-modal-fullscreen"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button className="settings-modal-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
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
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'style-profiles' && <StyleProfileSettings />}
            {activeTab === 'backup' && <BackupSettings />}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
