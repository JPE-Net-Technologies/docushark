/**
 * FileImportService — handles the full file import pipeline:
 * validation, blob storage, thumbnail generation, shape creation.
 */

import { nanoid } from 'nanoid';
import { Vec2 } from '../math/Vec2';
import type { FileShape, FileCategory } from '../shapes/Shape';
import { DEFAULT_FILE_SHAPE } from '../shapes/Shape';
import { blobStorage } from '../storage/BlobStorage';
import { hasSpaceForBlob } from '../storage/StorageQuotaMonitor';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { useNotificationStore } from '../store/notificationStore';
import { useSessionStore } from '../store/sessionStore';
import {
  detectFileCategory,
  getMimeType,
  sanitizeFileName,
  validateFileForEmbed,
} from '../utils/fileUtils';
import { generateThumbnail, type ThumbnailResult } from './ThumbnailGenerator';
import { validateFileIntegrity } from './FileIntegrityValidator';

export interface FileImportError {
  fileName: string;
  error: string;
}

export interface ImportResult {
  shapeIds: string[];
  errors: FileImportError[];
  totalSize: number;
}

export interface ImportContext {
  engine: {
    camera: {
      screenToWorld(point: Vec2): Vec2;
      getViewportCenter(): Vec2;
    };
    spatialIndex: { insert(shape: unknown): void };
    requestRender(): void;
  };
}

const GRID_COLUMNS = 3;
const GAP_X = DEFAULT_FILE_SHAPE.width + 20;
const GAP_Y = DEFAULT_FILE_SHAPE.height + 20;

export async function importFiles(
  files: FileList | File[],
  worldPosition: Vec2,
  context: ImportContext,
): Promise<ImportResult> {
  const shapeIds: string[] = [];
  const errors: FileImportError[] = [];
  let totalSize = 0;

  try {
    const fileArray = Array.from(files);
    const count = fileArray.length;

    useHistoryStore.getState().push(`Import ${count} file(s)`);

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i]!;
      const sanitizedName = sanitizeFileName(file.name);

      try {
        // Validate
        const validationError = validateFileForEmbed(file);
        if (validationError !== null) {
          errors.push({ fileName: sanitizedName, error: validationError });
          continue;
        }

        // Quota check
        const hasSpace = await hasSpaceForBlob(file.size);
        if (!hasSpace) {
          errors.push({ fileName: sanitizedName, error: 'Storage quota exceeded' });
          continue;
        }

        // MIME type — prefer extension-based detection since file.type
        // may be 'application/octet-stream' in Tauri/desktop environments
        const extensionMime = getMimeType(file.name);
        const mimeType = extensionMime !== 'application/octet-stream'
          ? extensionMime
          : (file.type || extensionMime);
        const fileCategory: FileCategory = detectFileCategory(mimeType, sanitizedName);

        // Validate file integrity (detect corrupt files early)
        const integrityResult = await validateFileIntegrity(
          new Blob([file], { type: mimeType }),
          fileCategory,
          mimeType,
        );
        if (!integrityResult.valid) {
          errors.push({
            fileName: sanitizedName,
            error: integrityResult.error ?? 'File appears to be corrupt',
          });
          continue;
        }

        // Store blob
        const blobRef = await blobStorage.saveBlob(
          new Blob([file], { type: mimeType }),
          sanitizedName,
        );

        // Thumbnail (best-effort)
        let thumbnail: ThumbnailResult | null = null;
        try {
          thumbnail = await generateThumbnail(
            new Blob([file], { type: mimeType }),
            mimeType,
            sanitizedName,
          );
        } catch {
          // Thumbnail failure is non-fatal
        }

        // Grid position
        const col = i % GRID_COLUMNS;
        const row = Math.floor(i / GRID_COLUMNS);
        const x = worldPosition.x + col * GAP_X;
        const y = worldPosition.y + row * GAP_Y;

        const fileShape: FileShape = {
          id: nanoid(),
          type: 'file',
          x,
          y,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          fill: DEFAULT_FILE_SHAPE.fill,
          stroke: DEFAULT_FILE_SHAPE.stroke,
          strokeWidth: DEFAULT_FILE_SHAPE.strokeWidth,
          width: DEFAULT_FILE_SHAPE.width,
          height: DEFAULT_FILE_SHAPE.height,
          blobRef,
          fileName: sanitizedName,
          mimeType,
          fileSize: file.size,
          fileCategory,
          labelFontSize: DEFAULT_FILE_SHAPE.labelFontSize,
          labelColor: DEFAULT_FILE_SHAPE.labelColor,
          ...(thumbnail !== null && {
            preview: {
              thumbnail: thumbnail.thumbnail,
              ...(thumbnail.pageCount !== undefined && { pageCount: thumbnail.pageCount }),
              ...(thumbnail.dimensions !== undefined && { dimensions: thumbnail.dimensions }),
            },
          }),
        };

        useDocumentStore.getState().addShape(fileShape);
        context.engine.spatialIndex.insert(fileShape);

        shapeIds.push(fileShape.id);
        totalSize += file.size;
      } catch (err) {
        errors.push({
          fileName: sanitizedName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    context.engine.requestRender();

    if (shapeIds.length > 0) {
      useSessionStore.getState().select(shapeIds);
      useSessionStore.getState().setActiveTool('select');
    }

    // Notification
    const notifications = useNotificationStore.getState();
    if (errors.length === 0 && shapeIds.length > 0) {
      notifications.success(`Imported ${shapeIds.length} file(s)`);
    } else if (shapeIds.length > 0 && errors.length > 0) {
      notifications.warning(
        `Imported ${shapeIds.length} file(s), ${errors.length} failed`,
      );
    } else if (shapeIds.length === 0) {
      notifications.error('Failed to import files');
    }
  } catch (err) {
    errors.push({
      fileName: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { shapeIds, errors, totalSize };
}
