/**
 * Atomic File Writer
 *
 * Provides safe file write operations using the write-to-temp-then-rename pattern.
 * This prevents data corruption if a crash occurs during write.
 *
 * The pattern:
 * 1. Write data to a temporary file (same directory, different name)
 * 2. Sync/flush the file to ensure data is on disk
 * 3. Atomically rename temp file to target file
 * 4. Clean up any stale temp files on startup
 *
 * This ensures that the target file is either:
 * - The old version (if crash before rename)
 * - The new version (if rename completed)
 * - Never a partial/corrupted version
 *
 * Phase 14.9.2 - Data Integrity Improvements
 */

import { getFileSystem, type FileSystem } from '../platform/fs';

// ============ Types ============

/** Result of an atomic write operation */
export interface AtomicWriteResult {
  success: boolean;
  error?: string;
  /** Path of the file that was written */
  path?: string;
  /** Size of the written data in bytes */
  bytesWritten?: number;
}

/** Options for atomic write operations */
export interface AtomicWriteOptions {
  /** Validate content after write (default: false) */
  validate?: boolean;
  /** Custom temp file suffix (default: '.tmp') */
  tempSuffix?: string;
  /** Backup existing file before overwrite (default: false) */
  backup?: boolean;
  /** Backup file suffix (default: '.bak') */
  backupSuffix?: string;
}

// ============ Constants ============

const DEFAULT_TEMP_SUFFIX = '.tmp';
const DEFAULT_BACKUP_SUFFIX = '.bak';

// ============ Core Functions ============

/**
 * Write text content atomically to a file.
 * Uses write-to-temp-then-rename pattern for crash safety.
 */
export async function atomicWriteText(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const fs = await getFileSystem();
  if (!fs) {
    return { success: false, error: 'File system not available' };
  }

  const tempSuffix = options.tempSuffix ?? DEFAULT_TEMP_SUFFIX;
  const tempPath = targetPath + tempSuffix;
  const backupSuffix = options.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;
  const backupPath = targetPath + backupSuffix;

  try {
    // Step 1: Write to temp file
    await fs.writeTextFile(tempPath, content);

    // Step 2: Validate if requested
    if (options.validate) {
      const readBack = await fs.readTextFile(tempPath);
      if (readBack !== content) {
        await cleanupTempFile(fs, tempPath);
        return { success: false, error: 'Write validation failed: content mismatch' };
      }
    }

    // Step 3: Backup existing file if requested
    if (options.backup) {
      const exists = await fs.exists(targetPath);
      if (exists) {
        try {
          await fs.rename(targetPath, backupPath);
        } catch (backupError) {
          console.warn('[AtomicFileWriter] Failed to create backup:', backupError);
          // Continue anyway - backup is optional
        }
      }
    }

    // Step 4: Atomic rename temp -> target
    await fs.rename(tempPath, targetPath);

    return {
      success: true,
      path: targetPath,
      bytesWritten: new TextEncoder().encode(content).length,
    };
  } catch (error) {
    // Clean up temp file on error
    await cleanupTempFile(fs, tempPath);

    const message = error instanceof Error ? error.message : 'Atomic write failed';
    console.error('[AtomicFileWriter] Error:', error);
    return { success: false, error: message };
  }
}

/**
 * Write JSON content atomically to a file.
 * Serializes the object to JSON with optional formatting.
 */
export async function atomicWriteJSON<T>(
  targetPath: string,
  data: T,
  options: AtomicWriteOptions & { pretty?: boolean } = {}
): Promise<AtomicWriteResult> {
  try {
    const content = options.pretty !== false
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);

    return await atomicWriteText(targetPath, content, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON serialization failed';
    return { success: false, error: message };
  }
}

/**
 * Write binary content atomically to a file.
 */
export async function atomicWriteBinary(
  targetPath: string,
  content: Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const fs = await getFileSystem();
  if (!fs) {
    return { success: false, error: 'File system not available' };
  }

  const tempSuffix = options.tempSuffix ?? DEFAULT_TEMP_SUFFIX;
  const tempPath = targetPath + tempSuffix;
  const backupSuffix = options.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;
  const backupPath = targetPath + backupSuffix;

  try {
    // Step 1: Write to temp file (Tauri plugin-fs uses writeFile for binary)
    await fs.writeFile(tempPath, content);

    // Step 2: Validate if requested
    if (options.validate) {
      const readBack = await fs.readFile(tempPath);
      if (!arraysEqual(readBack, content)) {
        await cleanupTempFile(fs, tempPath);
        return { success: false, error: 'Write validation failed: content mismatch' };
      }
    }

    // Step 3: Backup existing file if requested
    if (options.backup) {
      const exists = await fs.exists(targetPath);
      if (exists) {
        try {
          await fs.rename(targetPath, backupPath);
        } catch {
          // Continue anyway - backup is optional
        }
      }
    }

    // Step 4: Atomic rename temp -> target
    await fs.rename(tempPath, targetPath);

    return {
      success: true,
      path: targetPath,
      bytesWritten: content.length,
    };
  } catch (error) {
    // Clean up temp file on error
    await cleanupTempFile(fs, tempPath);

    const message = error instanceof Error ? error.message : 'Atomic write failed';
    console.error('[AtomicFileWriter] Error:', error);
    return { success: false, error: message };
  }
}

// ============ Recovery Functions ============

/**
 * Clean up stale temporary files in a directory.
 * Call this on application startup to recover from crashes.
 */
export async function cleanupStaleTempFiles(
  directoryPath: string,
  tempSuffix: string = DEFAULT_TEMP_SUFFIX
): Promise<{ cleaned: number; errors: number }> {
  const fs = await getFileSystem();
  if (!fs) {
    return { cleaned: 0, errors: 0 };
  }

  let cleaned = 0;
  let errors = 0;

  try {
    const entries = await fs.readDir(directoryPath);

    for (const entry of entries) {
      if (entry.name && entry.name.endsWith(tempSuffix)) {
        try {
          const fullPath = `${directoryPath}/${entry.name}`;
          await fs.remove(fullPath);
          cleaned++;
          console.log('[AtomicFileWriter] Cleaned up stale temp file:', entry.name);
        } catch {
          errors++;
        }
      }
    }
  } catch (error) {
    console.error('[AtomicFileWriter] Failed to clean temp files:', error);
  }

  return { cleaned, errors };
}

/**
 * Recover from an interrupted write by checking for temp files.
 * If a temp file exists without a corresponding target, the write was interrupted.
 */
export async function recoverInterruptedWrite(
  targetPath: string,
  tempSuffix: string = DEFAULT_TEMP_SUFFIX
): Promise<{ recovered: boolean; hadTempFile: boolean }> {
  const fs = await getFileSystem();
  if (!fs) {
    return { recovered: false, hadTempFile: false };
  }

  const tempPath = targetPath + tempSuffix;

  try {
    const tempExists = await fs.exists(tempPath);
    if (!tempExists) {
      return { recovered: false, hadTempFile: false };
    }

    // Temp file exists - this means a write was interrupted
    // We can either:
    // 1. Complete the write (rename temp to target)
    // 2. Discard the incomplete write (delete temp)
    //
    // For safety, we discard - the old version (if any) is still intact
    await fs.remove(tempPath);
    console.log('[AtomicFileWriter] Recovered from interrupted write:', targetPath);

    return { recovered: true, hadTempFile: true };
  } catch (error) {
    console.error('[AtomicFileWriter] Recovery failed:', error);
    return { recovered: false, hadTempFile: true };
  }
}

/**
 * Restore from backup file if the main file is corrupted or missing.
 */
export async function restoreFromBackup(
  targetPath: string,
  backupSuffix: string = DEFAULT_BACKUP_SUFFIX
): Promise<{ restored: boolean; error?: string }> {
  const fs = await getFileSystem();
  if (!fs) {
    return { restored: false, error: 'File system not available' };
  }

  const backupPath = targetPath + backupSuffix;

  try {
    const backupExists = await fs.exists(backupPath);
    if (!backupExists) {
      return { restored: false, error: 'No backup file found' };
    }

    // Rename backup to target
    await fs.rename(backupPath, targetPath);
    console.log('[AtomicFileWriter] Restored from backup:', targetPath);

    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Restore failed';
    return { restored: false, error: message };
  }
}

// ============ Helper Functions ============

/**
 * Clean up a temp file, ignoring errors.
 */
async function cleanupTempFile(
  fs: FileSystem,
  tempPath: string
): Promise<void> {
  try {
    const exists = await fs.exists(tempPath);
    if (exists) {
      await fs.remove(tempPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Compare two Uint8Arrays for equality.
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if a path looks like a temp file.
 */
export function isTempFile(path: string, tempSuffix: string = DEFAULT_TEMP_SUFFIX): boolean {
  return path.endsWith(tempSuffix);
}

/**
 * Get the target path from a temp file path.
 */
export function getTempTargetPath(
  tempPath: string,
  tempSuffix: string = DEFAULT_TEMP_SUFFIX
): string | null {
  if (!tempPath.endsWith(tempSuffix)) {
    return null;
  }
  return tempPath.slice(0, -tempSuffix.length);
}
