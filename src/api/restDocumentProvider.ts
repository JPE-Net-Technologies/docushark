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
import type { RelayClient } from './relayClient';

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
  constructor(private readonly client: RelayClient) {}

  async listDocuments(): Promise<DocumentMetadata[]> {
    const { documents } = await this.client.listDocuments();
    return documents;
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

  async transferDocumentOwnership(
    docId: string,
    newOwnerId: string,
    newOwnerName: string,
  ): Promise<void> {
    await this.client.transferDocumentOwnership(docId, newOwnerId, newOwnerName);
  }
}
