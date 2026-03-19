/**
 * ImageUploadButton - Upload images to Tiptap editor.
 *
 * Features:
 * - Click to upload or drag-and-drop
 * - Automatic image validation and resizing
 * - Stores images in IndexedDB blob storage
 * - Inserts blob:// URLs into editor
 */

import { useRef, useState } from 'react';
import { useTiptapEditor } from './TiptapEditorContext';
import { blobStorage } from '../storage/BlobStorage';
import { processImageForUpload, formatFileSize } from '../utils/imageUtils';

export interface ImageUploadButtonProps {
  /** Optional class name */
  className?: string;
}

export function ImageUploadButton({ className }: ImageUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const editor = useTiptapEditor();

  const handleFileSelect = async (file: File) => {
    setIsUploading(true);

    try {
      // Process image (validate, resize if needed)
      const { blob, name, originalSize, processedSize, wasResized } = await processImageForUpload(
        file
      );

      // Save to blob storage
      const blobId = await blobStorage.saveBlob(blob, name);

      // Insert into editor with blob:// URL
      if (editor) {
        editor
          .chain()
          .focus()
          .setImage({ src: `blob://${blobId}`, alt: name })
          .run();

        // Log if image was resized
        if (wasResized) {
          console.log(
            `Image resized: ${formatFileSize(originalSize)} → ${formatFileSize(processedSize)}`
          );
        }
      }
    } catch (error) {
      console.error('Failed to upload image:', error);
      alert(
        error instanceof Error
          ? error.message
          : 'Failed to upload image. Please try again.'
      );
    } finally {
      setIsUploading(false);

      // Reset input value to allow re-uploading same file
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`toolbar-button ${className ?? ''}`}
        onClick={handleClick}
        disabled={isUploading}
        title="Upload image"
        aria-label="Upload image"
      >
        {isUploading ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            {/* Loading spinner */}
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 8 8"
                to="360 8 8"
                dur="1s"
                repeatCount="indefinite"
              />
            </path>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            {/* Image icon */}
            <path d="M2 2h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 2v8h10V4H3zm2 6l2-2 1 1 2-3 3 4H5z" />
            <circle cx="5.5" cy="6.5" r="1" />
          </svg>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml"
        onChange={handleChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
}
