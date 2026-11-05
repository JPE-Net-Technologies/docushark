/**
 * The pickers behind the "/" commands (DSK-219): the image, file and gallery
 * choosers, the citation picker, and the field and reference managers. The prose
 * panel mounts this once, in every layout. They used to live in the desktop
 * ribbon, which a phone doesn't mount, so on a phone those commands did nothing.
 *
 * The seam holds one handler per action, so this is the only place that
 * registers them. The ribbon's upload buttons keep their own inputs for their
 * own clicks, and its "Manage references" asks here through `runSlashUi`.
 *
 * Nothing here runs on text that can't be edited: on a read-only document or a
 * mirror page the handlers are gone, and any open picker closes.
 */
import { useEffect, useState } from 'react';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { useActivePageMirror } from '../store/richTextPagesStore';
import { registerSlashUiHandler } from '../tiptap/slashCommands';
import { CitationPickerDialog } from './CitationPickerDialog';
import { FieldsManagerDialog } from './FieldsManagerDialog';
import { FileUploadButton } from './FileUploadButton';
import { GalleryUploadButton } from './GalleryUploadButton';
import { ImageUploadButton } from './ImageUploadButton';
import { ReferenceManagerDialog } from './ReferenceManagerDialog';
import { useTiptapEditor } from './TiptapEditorContext';

function SlashPickers() {
  const editor = useTiptapEditor();
  const [showCitationPicker, setShowCitationPicker] = useState(false);
  const [showRefManager, setShowRefManager] = useState(false);
  const [showFieldsManager, setShowFieldsManager] = useState(false);

  useEffect(() => registerSlashUiHandler('citation', () => setShowCitationPicker(true)), []);
  useEffect(() => registerSlashUiHandler('references', () => setShowRefManager(true)), []);
  useEffect(() => registerSlashUiHandler('field', () => setShowFieldsManager(true)), []);

  return (
    <>
      {/* Their buttons are never seen: "/" opens their file inputs. */}
      <div hidden>
        <ImageUploadButton slashTarget />
        <FileUploadButton slashTarget />
        <GalleryUploadButton slashTarget />
      </div>

      {/* Citations (JP-89) */}
      {showCitationPicker && editor && (
        <CitationPickerDialog
          editor={editor}
          onClose={() => setShowCitationPicker(false)}
          onManageReferences={() => setShowRefManager(true)}
        />
      )}
      {showRefManager && <ReferenceManagerDialog onClose={() => setShowRefManager(false)} />}

      {/* Document Fields (Phase 3) */}
      {showFieldsManager && editor && (
        <FieldsManagerDialog editor={editor} onClose={() => setShowFieldsManager(false)} />
      )}
    </>
  );
}

export function SlashUiHost() {
  const docReadOnly = useActiveDocReadOnly();
  const activeMirror = useActivePageMirror();
  return docReadOnly || activeMirror ? null : <SlashPickers />;
}
