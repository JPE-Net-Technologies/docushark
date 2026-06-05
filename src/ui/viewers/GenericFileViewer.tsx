import { formatFileSize, detectFileCategory } from '../../utils/fileUtils';
import { getFileTypeLucideIcon } from '../../utils/fileTypeIcons';
import { Icon } from '../icons';
import './GenericFileViewer.css';

export interface GenericFileViewerProps {
  fileName: string;
  fileSize: number;
  mimeType: string;
  blobRef?: string | undefined;
}

export function GenericFileViewer({ fileName, fileSize, mimeType }: GenericFileViewerProps) {
  const FileIcon = getFileTypeLucideIcon(detectFileCategory(mimeType, fileName));

  return (
    <div className="generic-viewer">
      <div className="generic-viewer-card">
        <div className="generic-viewer-icon"><Icon icon={FileIcon} size={48} /></div>
        <div className="generic-viewer-name">{fileName}</div>
        <div className="generic-viewer-meta">
          {formatFileSize(fileSize)} · {mimeType}
        </div>
        <div className="generic-viewer-message">
          No preview available for this file type.
        </div>
        <div className="generic-viewer-hint">
          Use the Download button to save and open with your system application.
        </div>
      </div>
    </div>
  );
}

export default GenericFileViewer;
