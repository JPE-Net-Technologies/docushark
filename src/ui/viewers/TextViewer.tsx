import { useState, useEffect, useRef, useCallback } from 'react';
import './TextViewer.css';

export interface TextViewerProps {
  blobUrl: string;
  fileName: string;
}

export function TextViewer({ blobUrl, fileName: _fileName }: TextViewerProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [lineCount, setLineCount] = useState(0);

  const gutterRef = useRef<HTMLPreElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);

  // Load text content from blobUrl
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(blobUrl)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setLineCount(text.split('\n').length);
          setLoading(false);
        }
      })
      .catch((_err) => {
        if (!cancelled) {
          setError('Failed to load file content');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [blobUrl]);

  // Sync scroll between gutter and content
  const handleContentScroll = useCallback(() => {
    if (gutterRef.current && contentRef.current) {
      gutterRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((prev) => !prev);
  }, []);

  if (loading) {
    return (
      <div className="text-viewer">
        <div className="text-viewer-loading">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-viewer">
        <div className="text-viewer-error">
          <span className="text-viewer-error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  // Build line numbers as a single string
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div className="text-viewer">
      <div className="text-viewer-toolbar">
        <span className="text-viewer-line-count">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        <label className="text-viewer-wrap-toggle">
          <input type="checkbox" checked={wordWrap} onChange={toggleWordWrap} />
          <span>Word Wrap</span>
        </label>
      </div>
      <div className="text-viewer-body">
        <pre
          ref={gutterRef}
          className="text-viewer-gutter"
          aria-hidden="true"
        >
          {lineNumbers}
        </pre>
        <pre
          ref={contentRef}
          className={`text-viewer-content${wordWrap ? ' wrap' : ''}`}
          onScroll={handleContentScroll}
        >
          {content}
        </pre>
      </div>
    </div>
  );
}

export default TextViewer;
