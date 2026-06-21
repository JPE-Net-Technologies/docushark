/**
 * Export dialog for PNG and SVG export options.
 */

import { useState, useCallback } from 'react';
import { exportToPng, exportToSvg, getExportBounds, ExportOptions, ExportData } from '../utils/exportUtils';
import { downloadBlob, downloadSvg } from '../utils/downloadUtils';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import './ExportDialog.css';

export interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  scope: 'all' | 'selection';
  defaultFilename?: string;
}

export function ExportDialog({ isOpen, onClose, scope, defaultFilename = 'diagram' }: ExportDialogProps) {
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState<string | null>('#ffffff');
  const [useTransparent, setUseTransparent] = useState(false);
  const [padding, setPadding] = useState(20);
  const [filename, setFilename] = useState(defaultFilename);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shapes = useDocumentStore((s) => s.shapes);
  const shapeOrder = useDocumentStore((s) => s.shapeOrder);
  const selectedIds = useSessionStore((s) => s.selectedIds);

  const handleExport = useCallback(async () => {
    setError(null);
    setIsExporting(true);

    try {
      const data: ExportData = {
        shapes,
        shapeOrder,
        selectedIds: Array.from(selectedIds),
      };

      // Check if there are shapes to export
      const bounds = getExportBounds(data, scope);
      if (!bounds) {
        setError('No visible shapes to export');
        setIsExporting(false);
        return;
      }

      const options: ExportOptions = {
        format,
        scope,
        scale,
        background: useTransparent ? null : background,
        padding,
        filename,
      };

      const exportFilename = `${filename}.${format}`;

      if (format === 'png') {
        const blob = await exportToPng(data, options);
        downloadBlob(blob, exportFilename);
      } else {
        const svgString = exportToSvg(data, options);
        downloadSvg(svgString, exportFilename);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }, [shapes, shapeOrder, selectedIds, scope, format, scale, background, useTransparent, padding, filename, onClose]);

  if (!isOpen) return null;

  return (
    <div className="export-dialog-overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog-header">
          <h2>Export {scope === 'selection' ? 'Selection' : 'Diagram'}</h2>
          <button className="export-dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="export-dialog-content">
          {/* Format selection */}
          <div className="export-option">
            <label className="export-label">Format</label>
            <div className="export-format-toggle">
              <button
                className={`export-format-btn ${format === 'png' ? 'active' : ''}`}
                onClick={() => setFormat('png')}
              >
                PNG
              </button>
              <button
                className={`export-format-btn ${format === 'svg' ? 'active' : ''}`}
                onClick={() => setFormat('svg')}
              >
                SVG
              </button>
            </div>
          </div>

          {/* Scale (PNG only) */}
          {format === 'png' && (
            <div className="export-option">
              <label className="export-label">Scale</label>
              <select
                className="export-select"
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
              >
                <option value={1}>1x (Standard)</option>
                <option value={2}>2x (High DPI)</option>
                <option value={3}>3x (Retina)</option>
              </select>
            </div>
          )}

          {/* Background */}
          <div className="export-option">
            <label className="export-label">Background</label>
            <div className="export-background-options">
              <label className="export-checkbox-label">
                <input
                  type="checkbox"
                  checked={useTransparent}
                  onChange={(e) => setUseTransparent(e.target.checked)}
                />
                Transparent
              </label>
              {!useTransparent && (
                <input
                  type="color"
                  className="export-color"
                  value={background || '#ffffff'}
                  onChange={(e) => setBackground(e.target.value)}
                />
              )}
            </div>
            <p className="export-hint">
              “Automatic” shape colors adapt to this surface — dark ink on a light
              background, light on a dark one
              {useTransparent ? ' (transparent is treated as light).' : '.'}
            </p>
          </div>

          {/* Padding */}
          <div className="export-option">
            <label className="export-label">Padding</label>
            <div className="export-input-group">
              <input
                type="number"
                className="export-number"
                value={padding}
                min={0}
                max={100}
                onChange={(e) => setPadding(Math.max(0, Math.min(100, Number(e.target.value))))}
              />
              <span className="export-unit">px</span>
            </div>
          </div>

          {/* Filename */}
          <div className="export-option">
            <label className="export-label">Filename</label>
            <div className="export-filename-group">
              <input
                type="text"
                className="export-text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="diagram"
              />
              <span className="export-extension">.{format}</span>
            </div>
          </div>

          {/* Error message */}
          {error && <div className="export-error">{error}</div>}
        </div>

        <div className="export-dialog-footer">
          <button className="export-btn export-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="export-btn export-btn-primary"
            onClick={handleExport}
            disabled={isExporting || !filename.trim()}
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
