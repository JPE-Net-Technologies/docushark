/**
 * VideoViewer — native <video> playback for embedded video files. Codec
 * support depends on the platform (WebKitGTK needs the matching GStreamer
 * plugins), so a decode failure falls back to a download prompt instead of a
 * dead player.
 */

import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Icon } from '../icons';
import './MediaViewer.css';

export interface VideoViewerProps {
  blobUrl: string;
  fileName: string;
}

export function VideoViewer({ blobUrl, fileName }: VideoViewerProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="media-viewer media-viewer--error">
        <span className="media-viewer__error-icon">
          <Icon icon={TriangleAlert} size={24} />
        </span>
        <span>This video format can't be played on this system.</span>
        <span className="media-viewer__hint">Use Download to save and play it in another app.</span>
      </div>
    );
  }

  return (
    <div className="media-viewer media-viewer--video">
      {/* Object URL is owned by the blobResolver cache — never revoked here. */}
      <video
        className="media-viewer__video"
        src={blobUrl}
        controls
        onError={() => setFailed(true)}
        aria-label={fileName}
      />
    </div>
  );
}

export default VideoViewer;
