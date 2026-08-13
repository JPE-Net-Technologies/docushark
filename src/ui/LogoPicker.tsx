/**
 * LogoPicker - Modal for selecting a logo from blob storage.
 *
 * Used in PDF export to select a logo for the cover page.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { blobStorage } from '../storage/BlobStorage';
import { assertUploadable } from '../storage/uploadLimits';
import type { BlobMetadata } from '../storage/BlobTypes';
import { formatFileSize } from '../utils/byteSize';
import './LogoPicker.css';

export interface LogoPickerProps {
  /** Whether the picker is open */
  isOpen: boolean;
  /** Currently selected blob ID */
  selectedId: string | null;
  /** Called when selection changes */
  onSelect: (blobId: string | null) => void;
  /** Called when picker should close */
  onClose: () => void;
}

export function LogoPicker({ isOpen, selectedId, onSelect, onClose }: LogoPickerProps) {
  const [blobs, setBlobs] = useState<BlobMetadata[]>([]);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(selectedId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load image blobs
  useEffect(() => {
    if (!isOpen) return;

    const loadBlobs = async () => {
      setIsLoading(true);
      try {
        const allBlobs = await blobStorage.listAllBlobs();
        // Filter to only image types
        const imageBlobs = allBlobs.filter((b) =>
          b.type.startsWith('image/')
        );
        setBlobs(imageBlobs.sort((a, b) => b.createdAt - a.createdAt));

        // Load previews
        const newPreviews = new Map<string, string>();
        for (const blob of imageBlobs) {
          try {
            const data = await blobStorage.loadBlob(blob.id);
            if (data) {
              const url = URL.createObjectURL(data);
              newPreviews.set(blob.id, url);
            }
          } catch {
            // Skip failed previews
          }
        }
        setPreviews(newPreviews);
      } catch (error) {
        console.error('Failed to load blobs:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadBlobs();

    // Cleanup blob URLs on unmount
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [isOpen]);

  // Sync local selection with prop
  useEffect(() => {
    setLocalSelectedId(selectedId);
  }, [selectedId]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    setIsUploading(true);
    try {
      // This path had neither a size ceiling nor a quota check, so a large
      // image picked as a logo went straight into `computeHash`, which buffers
      // the whole file (JP-496).
      await assertUploadable(file);
      const blobId = await blobStorage.saveBlob(file, file.name);

      // Reload blobs
      const allBlobs = await blobStorage.listAllBlobs();
      const imageBlobs = allBlobs.filter((b) => b.type.startsWith('image/'));
      setBlobs(imageBlobs.sort((a, b) => b.createdAt - a.createdAt));

      // Load preview for new blob
      const data = await blobStorage.loadBlob(blobId);
      if (data) {
        const url = URL.createObjectURL(data);
        setPreviews((prev) => new Map(prev).set(blobId, url));
      }

      // Select the newly uploaded image
      setLocalSelectedId(blobId);
    } catch (error) {
      console.error('Failed to upload logo:', error);
      alert('Failed to upload image');
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, []);

  const handleConfirm = useCallback(() => {
    onSelect(localSelectedId);
    onClose();
  }, [localSelectedId, onSelect, onClose]);

  const handleClearSelection = useCallback(() => {
    setLocalSelectedId(null);
  }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="logo-picker-overlay" onClick={handleOverlayClick}>
      <div className="logo-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="logo-picker-header">
          <h3>Select Logo</h3>
          <button className="logo-picker-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="logo-picker-content">
          {/* Upload button */}
          <div className="logo-picker-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
            <button
              className="logo-picker-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? 'Uploading...' : '+ Upload New Image'}
            </button>
          </div>

          {/* Images grid */}
          {isLoading ? (
            <div className="logo-picker-loading">Loading images...</div>
          ) : blobs.length === 0 ? (
            <div className="logo-picker-empty">
              No images in storage. Upload one to use as a logo.
            </div>
          ) : (
            <div className="logo-picker-grid">
              {blobs.map((blob) => (
                <div
                  key={blob.id}
                  className={`logo-picker-item ${localSelectedId === blob.id ? 'selected' : ''}`}
                  onClick={() => setLocalSelectedId(blob.id)}
                  title={blob.name}
                >
                  <div className="logo-picker-preview">
                    {previews.get(blob.id) ? (
                      <img src={previews.get(blob.id)} alt={blob.name} />
                    ) : (
                      <div className="logo-picker-placeholder">?</div>
                    )}
                  </div>
                  <div className="logo-picker-name">{blob.name}</div>
                  <div className="logo-picker-size">{formatFileSize(blob.size)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="logo-picker-footer">
          <button
            className="logo-picker-btn logo-picker-btn-secondary"
            onClick={handleClearSelection}
            disabled={localSelectedId === null}
          >
            No Logo
          </button>
          <div className="logo-picker-footer-right">
            <button className="logo-picker-btn logo-picker-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="logo-picker-btn logo-picker-btn-primary" onClick={handleConfirm}>
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
