/**
 * FileUploadButton — attach a file to prose (JP-495).
 *
 * Mirrors `ImageUploadButton`: pick a file, persist it to blob storage, insert
 * the node. No `accept` filter — the point of an attachment is that it can be
 * anything (images have their own button, which also processes and downscales).
 */

import { useEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';

import { Icon } from './icons';
import { useTiptapEditor } from './TiptapEditorContext';
import { uploadProseFile } from './proseFileUpload';
import { registerSlashUiHandler } from '../tiptap/slashCommands';
import { useNotificationStore } from '../store/notificationStore';
import { tip } from './TooltipLayer';

export interface FileUploadButtonProps {
  className?: string;
  /** One sentence under the name in its tooltip (DSK-217). */
  description?: string | undefined;
  /** This instance opens for the matching "/" command (SlashUiHost's, DSK-219). */
  slashTarget?: boolean;
}

export function FileUploadButton({ className, description, slashTarget = false }: FileUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const editor = useTiptapEditor();

  const handleFileSelect = async (file: File) => {
    setIsUploading(true);
    try {
      const attrs = await uploadProseFile(file);
      // Insert after the write succeeds: a chip pointing at a blob that failed
      // to store would render as permanently unavailable.
      editor?.chain().focus().insertFileRef(attrs).run();
    } catch (error) {
      console.error('Failed to attach file:', error);
      useNotificationStore
        .getState()
        .error(error instanceof Error ? error.message : 'Failed to attach that file.');
    } finally {
      setIsUploading(false);
      // Reset so picking the same file twice still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleClick = () => inputRef.current?.click();

  // `/file` opens this same picker — the upload flow lives here, not in the
  // editor. No-op headless: nothing is registered.
  // Only the slash host's instance answers "/" (DSK-219); the ribbon's button
  // keeps its own input for its own clicks.
  useEffect(
    () => (slashTarget ? registerSlashUiHandler('file', () => inputRef.current?.click()) : undefined),
    [slashTarget],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  return (
    <>
      <button
        type="button"
        className={`toolbar-button ${className ?? ''}`}
        onClick={handleClick}
        disabled={isUploading}
        {...tip('Attach file', undefined, description)}
        aria-label="Attach file"
      >
        {isUploading ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
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
          <Icon icon={Paperclip} />
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        onChange={handleChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </>
  );
}
