import { useRef, useState, useCallback } from 'react';
import { importFiles, ImportContext } from '../services/FileImportService';
import './FileImportButton.css';

interface FileImportButtonProps {
  getImportContext: () => ImportContext | null;
}

export function FileImportButton({ getImportContext }: FileImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleClick = useCallback(() => {
    if (!isImporting) {
      inputRef.current?.click();
    }
  }, [isImporting]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const ctx = getImportContext();
    if (!ctx) return;

    setIsImporting(true);
    try {
      const center = ctx.engine.camera.getViewportCenter();
      await importFiles(files, center, ctx);
    } finally {
      setIsImporting(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  }, [getImportContext]);

  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="tool-button-wrapper">
      <button
        className={`tool-button file-import-btn ${isImporting ? 'importing' : ''}`}
        onClick={handleClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        disabled={isImporting}
        aria-label="Embed files"
        title=""
      >
        <span className="tool-button-icon">
          {isImporting ? (
            <svg className="file-import-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite" />
              </path>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 10v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3" />
              <path d="M8 2v8" />
              <path d="M5 7l3 3 3-3" />
            </svg>
          )}
        </span>
      </button>
      {showTooltip && !isImporting && (
        <div className="tool-button-tooltip">
          Embed File
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="file-import-hidden-input"
        onChange={handleFileSelect}
        tabIndex={-1}
      />
    </div>
  );
}
