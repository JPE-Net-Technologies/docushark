/**
 * AudioViewer — native <audio> playback for embedded audio files. Codec
 * support depends on the platform (WebKitGTK needs the matching GStreamer
 * plugins), so a decode failure falls back to a download prompt instead of a
 * dead player.
 */

import { useState } from 'react';
import { FileAudio, TriangleAlert } from 'lucide-react';
import { Icon } from '../icons';
import './MediaViewer.css';

export interface AudioViewerProps {
  blobUrl: string;
  fileName: string;
}

export function AudioViewer({ blobUrl, fileName }: AudioViewerProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="media-viewer media-viewer--error">
        <span className="media-viewer__error-icon">
          <Icon icon={TriangleAlert} size={24} />
        </span>
        <span>This audio format can't be played on this system.</span>
        <span className="media-viewer__hint">Use Download to save and play it in another app.</span>
      </div>
    );
  }

  return (
    <div className="media-viewer">
      <span className="media-viewer__glyph">
        <Icon icon={FileAudio} size={48} />
      </span>
      <span className="media-viewer__name" title={fileName}>
        {fileName}
      </span>
      {/* Object URL is owned by the blobResolver cache — never revoked here. */}
      <audio
        className="media-viewer__audio"
        src={blobUrl}
        controls
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default AudioViewer;
