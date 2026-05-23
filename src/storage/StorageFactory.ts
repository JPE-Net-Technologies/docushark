/**
 * Storage Factory
 *
 * Factory for creating and selecting appropriate storage backends
 * based on document type (Personal vs Team) and runtime environment.
 */

import { StorageBackend, StorageBackendConfig, StorageBackendType } from './StorageBackend';
import { LocalStorageBackend, localStorageBackend } from './LocalStorageBackend';
import { FileSystemBackend, createFileSystemBackend } from './FileSystemBackend';
import { isTauri } from '../tauri/commands';

/**
 * Document storage mode
 */
export type StorageMode = 'personal' | 'team';

/**
 * Storage factory configuration
 */
export interface StorageFactoryConfig {
  /**
   * Default storage mode when not specified
   */
  defaultMode?: StorageMode;

  /**
   * Configuration for file system backend
   */
  fileSystemConfig?: StorageBackendConfig;

  /**
   * Whether to prefer file system over localStorage for personal documents
   * in Tauri environment (default: false)
   */
  preferFileSystemForPersonal?: boolean;
}

/**
 * Factory for creating and managing storage backends.
 *
 * Handles the selection logic between different storage backends:
 * - Personal Documents: localStorage (browser/Tauri) or fileSystem (Tauri only)
 * - Relay Documents: fileSystem (Tauri only, synced via WebSocket)
 */
export class StorageFactory {
  private config: StorageFactoryConfig;
  private localStorageBackend: LocalStorageBackend;
  private fileSystemBackend: FileSystemBackend | null = null;

  constructor(config?: StorageFactoryConfig) {
    this.config = {
      defaultMode: 'personal',
      preferFileSystemForPersonal: false,
      ...config,
    };

    this.localStorageBackend = localStorageBackend;

    // Create file system backend if in Tauri environment
    if (isTauri()) {
      this.fileSystemBackend = createFileSystemBackend(config?.fileSystemConfig);
    }
  }

  /**
   * Get the appropriate storage backend for the given mode
   * @param mode - Storage mode (personal or team)
   * @returns The appropriate storage backend
   */
  getBackend(mode?: StorageMode): StorageBackend {
    const effectiveMode = mode ?? this.config.defaultMode ?? 'personal';

    if (effectiveMode === 'team') {
      // Team documents always use file system (requires Tauri)
      if (this.fileSystemBackend) {
        return this.fileSystemBackend;
      }
      // Fallback to localStorage if file system not available
      console.warn('Team mode requested but file system not available, falling back to localStorage');
      return this.localStorageBackend;
    }

    // Personal mode
    if (this.config.preferFileSystemForPersonal && this.fileSystemBackend) {
      return this.fileSystemBackend;
    }

    return this.localStorageBackend;
  }

  /**
   * Get the localStorage backend directly
   */
  getLocalStorageBackend(): LocalStorageBackend {
    return this.localStorageBackend;
  }

  /**
   * Get the file system backend if available
   */
  getFileSystemBackend(): FileSystemBackend | null {
    return this.fileSystemBackend;
  }

  /**
   * Check which backends are available
   */
  async getAvailableBackends(): Promise<StorageBackendType[]> {
    const available: StorageBackendType[] = [];

    if (await this.localStorageBackend.isAvailable()) {
      available.push('localStorage');
    }

    if (this.fileSystemBackend && (await this.fileSystemBackend.isAvailable())) {
      available.push('fileSystem');
    }

    return available;
  }

  /**
   * Check if relay mode is supported (requires Tauri file system).
   * Renamed from `isTeamModeSupported` in Phase 20.3 Slice B.
   */
  isRelayModeSupported(): boolean {
    return this.fileSystemBackend !== null;
  }

  /**
   * Update the factory configuration
   */
  updateConfig(config: Partial<StorageFactoryConfig>): void {
    this.config = { ...this.config, ...config };

    // Recreate file system backend if config changed
    if (config.fileSystemConfig && isTauri()) {
      this.fileSystemBackend = createFileSystemBackend(config.fileSystemConfig);
    }
  }

  /**
   * Set the base path for file system storage
   */
  setFileSystemBasePath(path: string): void {
    if (this.fileSystemBackend) {
      this.fileSystemBackend.setBasePath(path);
    }
  }
}

/**
 * Singleton instance of StorageFactory
 */
export const storageFactory = new StorageFactory();

/**
 * Convenience function to get storage backend for a mode
 */
export function getStorageBackend(mode?: StorageMode): StorageBackend {
  return storageFactory.getBackend(mode);
}
