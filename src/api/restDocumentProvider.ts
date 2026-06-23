/**
 * REST adapter that conforms `RelayClient` to the `DocumentProvider`
 * interface consumed by `useRelayDocumentStore`. Phase 20.3 Slice E.2 —
 * lets the store route CRUD through the standalone relay's REST API
 * instead of the WS-multiplexed handlers in `UnifiedSyncProvider`.
 *
 * Keeping the adapter thin (one file, mostly delegation) means the
 * store stays transport-agnostic and the eventual deletion of the WS
 * CRUD path in E.3 doesn't ripple beyond `UnifiedSyncProvider.ts`.
 */

import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import type { RelayClient, RelayCollectionDef, RelayUsage } from './relayClient';
import {
  BlobSyncService,
  type BlobSyncProgress,
  type BlobSyncResult,
} from '../collaboration/BlobSyncService';

/** Share entry shape carried by the store's `updateDocumentShares`. */
export interface DocumentProviderShareEntry {
  userId: string;
  userName: string;
  permission: string;
}

/**
 * Implements the `DocumentProvider` shape defined in
 * `relayDocumentStore.ts`. We don't import that interface to keep
 * directional dependencies clean (store -> adapter, not the reverse).
 */
export class RestDocumentProvider {
  /**
   * Syncs relay-doc assets to/from the relay blob store. The `RelayClient`
   * satisfies `BlobTransport` directly, so blob traffic reuses the same
   * bearer token + 401 → refresh path as document CRUD (JP-118).
   */
  private readonly blobSync: BlobSyncService;

  constructor(private readonly client: RelayClient) {
    this.blobSync = new BlobSyncService({ transport: client });
  }

  async listDocuments(): Promise<DocumentMetadata[]> {
    const { documents } = await this.client.listDocuments();
    return documents;
  }

  async getUsage(): Promise<RelayUsage> {
    return this.client.getUsage();
  }

  async getDocument(
    docId: string,
  ): Promise<{ document: DiagramDocument; serverVersion?: number }> {
    const document = await this.client.getDocument(docId);
    const serverVersion = (document as { serverVersion?: unknown }).serverVersion;
    return typeof serverVersion === 'number'
      ? { document, serverVersion }
      : { document };
  }

  async saveDocument(
    doc: DiagramDocument,
    expectedVersion?: number,
  ): Promise<{ newVersion?: number }> {
    const { newVersion } = await this.client.saveDocument(doc.id, doc, expectedVersion);
    return typeof newVersion === 'number' ? { newVersion } : {};
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.client.deleteDocument(docId);
  }

  async updateDocumentShares(
    docId: string,
    shares: DocumentProviderShareEntry[],
  ): Promise<void> {
    await this.client.updateDocumentShares(docId, shares);
  }

  /** True when there's a JWT to send. Used by `SyncStateManager` to gate queue flushes. */
  isReady(): boolean {
    return this.client.getToken() !== undefined;
  }

  /**
   * Upload the blobs a relay doc references to the blob store, before the
   * doc save. Only blobs the relay is missing are sent (deduped server-side).
   */
  async uploadBlobs(
    hashes: string[],
    onProgress?: (progress: BlobSyncProgress) => void,
  ): Promise<BlobSyncResult> {
    return this.blobSync.ensureBlobsUploaded(hashes, onProgress);
  }

  /**
   * Download into local IndexedDB any referenced blobs missing locally,
   * after a relay doc load — so blob:// refs render and the doc stays
   * viewable offline from the cache.
   */
  async downloadBlobs(hashes: string[]): Promise<BlobSyncResult> {
    return this.blobSync.downloadMissingBlobs(hashes);
  }

  async transferDocumentOwnership(
    docId: string,
    newOwnerId: string,
    newOwnerName: string,
  ): Promise<void> {
    await this.client.transferDocumentOwnership(docId, newOwnerId, newOwnerName);
  }

  // ============ Collections (JP-159) ============

  async getCollections(): Promise<RelayCollectionDef[]> {
    const { collections } = await this.client.getCollections();
    return collections;
  }

  async setCollections(collections: RelayCollectionDef[]): Promise<void> {
    await this.client.setCollections(collections);
  }

  async setDocumentCollection(docId: string, collectionId: string | null): Promise<void> {
    await this.client.setDocumentCollection(docId, collectionId);
  }
}
