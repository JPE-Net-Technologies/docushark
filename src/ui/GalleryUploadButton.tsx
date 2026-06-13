/**
 * GalleryUploadButton - Upload multiple images at once and insert them as a
 * gallery (grid). Mirrors ImageUploadButton's blob-save flow, looped over files.
 */

import { useEffect, useRef, useState } from 'react';
import { Images } from 'lucide-react';
import { Icon } from './icons';
import { useTiptapEditor } from './TiptapEditorContext';
import { blobStorage } from '../storage/BlobStorage';
import { processImageForUpload } from '../utils/imageUtils';
import { registerSlashUiHandler } from '../tiptap/slashCommands';
import type { GalleryImage } from '../tiptap/GalleryExtension';

export interface GalleryUploadButtonProps {
  className?: string;
}

export function GalleryUploadButton({ className }: GalleryUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const editor = useTiptapEditor();

  const handleFiles = async (files: FileList) => {
    if (!editor || files.length === 0) return;
    setIsUploading(true);
    try {
      const images: GalleryImage[] = [];
      for (const file of Array.from(files)) {
        try {
          const { blob, name } = await processImageForUpload(file);
          const blobId = await blobStorage.saveBlob(blob, name);
          images.push({ src: `blob://${blobId}`, alt: name });
        } catch (error) {
          // Skip a bad file but keep the rest of the gallery.
          console.error('Failed to process gallery image:', error);
        }
      }
      if (images.length > 0) {
        editor.chain().focus().insertGallery(images).run();
      }
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  // Let the `/gallery` slash command open the same multi-file picker.
  useEffect(() => registerSlashUiHandler('gallery', () => inputRef.current?.click()), []);

  return (
    <>
      <button
        type="button"
        className={`toolbar-button ${className ?? ''}`}
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        title="Insert image gallery"
        aria-label="Insert image gallery"
      >
        {isUploading ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite" />
            </path>
          </svg>
        ) : (
          <Icon icon={Images} />
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml"
        multiple
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
        }}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
}
