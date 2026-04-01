/**
 * File utility functions for embedded file shapes.
 *
 * Provides MIME type detection, file categorization, size formatting,
 * and icon mapping for the file embedding system.
 */

/** File category for viewer dispatch */
export type FileCategory = 'pdf' | 'spreadsheet' | 'image' | 'text' | 'generic';

/**
 * Detect the file category from MIME type and filename.
 * Used to determine which viewer to use and which icon to display.
 */
export function detectFileCategory(mimeType: string, fileName: string): FileCategory {
  const mime = mimeType.toLowerCase();
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  // PDF
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';

  // Spreadsheets
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
    mime === 'text/csv' ||
    ['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(ext)
  ) return 'spreadsheet';

  // Images
  if (
    mime.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tiff', 'tif'].includes(ext)
  ) return 'image';

  // Text/code files
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript' ||
    mime === 'application/x-yaml' ||
    mime === 'application/toml' ||
    [
      'txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'toml',
      'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'htm',
      'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
      'sql', 'graphql', 'gql', 'proto',
      'env', 'ini', 'cfg', 'conf', 'config',
      'log', 'diff', 'patch',
      'dockerfile', 'makefile', 'cmake',
    ].includes(ext)
  ) return 'text';

  return 'generic';
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Get a representative emoji icon for a file category.
 */
export function getFileTypeIcon(category: FileCategory): string {
  switch (category) {
    case 'pdf': return '📕';
    case 'spreadsheet': return '📊';
    case 'image': return '🖼️';
    case 'text': return '📝';
    case 'generic': return '📄';
  }
}

/**
 * Guess MIME type from filename extension.
 * Returns 'application/octet-stream' for unknown types.
 */
export function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  const mimeMap: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    // Spreadsheets
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    xml: 'application/xml',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    toml: 'application/toml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'application/typescript',
    jsx: 'application/javascript',
    tsx: 'application/typescript',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    sh: 'text/x-shellscript',
    sql: 'text/x-sql',
    log: 'text/plain',
    // Archives
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    rar: 'application/x-rar-compressed',
    // Media
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };

  return mimeMap[ext] ?? 'application/octet-stream';
}

/**
 * Check whether a specialized viewer exists for this MIME type.
 */
export function isPreviewableFile(mimeType: string): boolean {
  const category = detectFileCategory(mimeType, '');
  return category !== 'generic';
}

/** Maximum file size for embedded files (50MB) */
export const MAX_EMBEDDED_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Validate a file for embedding. Returns an error message string, or null if valid.
 */
export function validateFileForEmbed(file: File): string | null {
  if (file.size === 0) {
    return 'File is empty (0 bytes)';
  }
  if (file.size > MAX_EMBEDDED_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return `File too large: ${sizeMB} MB. Maximum size is ${MAX_EMBEDDED_FILE_SIZE / (1024 * 1024)} MB`;
  }
  return null;
}

/**
 * Sanitize a filename for safe display and storage.
 * Removes path separators, trims whitespace, limits length.
 */
export function sanitizeFileName(name: string): string {
  let sanitized = name
    .replace(/[\\/]/g, '') // Remove path separators
    .replace(/[<>:"|?*\x00-\x1f]/g, '') // Remove invalid filename chars
    .trim();

  if (sanitized.length > 200) {
    const ext = sanitized.lastIndexOf('.');
    if (ext > 0 && sanitized.length - ext <= 10) {
      // Preserve extension
      const extension = sanitized.slice(ext);
      sanitized = sanitized.slice(0, 200 - extension.length) + extension;
    } else {
      sanitized = sanitized.slice(0, 200);
    }
  }

  return sanitized || 'Untitled';
}
