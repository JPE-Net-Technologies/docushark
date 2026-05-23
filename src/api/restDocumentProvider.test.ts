import { describe, it, expect } from 'vitest';
import { RestDocumentProvider } from './restDocumentProvider';
import type { RelayClient } from './relayClient';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';

interface Call {
  method: string;
  args: unknown[];
}

function makeStubClient(overrides: Partial<RelayClient> = {}): {
  client: RelayClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const stub = {
    async listDocuments() {
      calls.push({ method: 'listDocuments', args: [] });
      return { documents: [] as DocumentMetadata[] };
    },
    async getDocument(id: string) {
      calls.push({ method: 'getDocument', args: [id] });
      return { id, name: 'D', serverVersion: 3 } as unknown as DiagramDocument;
    },
    async saveDocument(id: string, doc: DiagramDocument, expectedVersion?: number) {
      calls.push({ method: 'saveDocument', args: [id, doc, expectedVersion] });
      return { success: true, newVersion: 4 };
    },
    async deleteDocument(id: string) {
      calls.push({ method: 'deleteDocument', args: [id] });
      return { success: true };
    },
    async updateDocumentShares(id: string, shares: unknown[]) {
      calls.push({ method: 'updateDocumentShares', args: [id, shares] });
      return { success: true };
    },
    async transferDocumentOwnership(id: string, newOwnerId: string, newOwnerName: string) {
      calls.push({ method: 'transferDocumentOwnership', args: [id, newOwnerId, newOwnerName] });
      return { success: true };
    },
    ...overrides,
  };
  return { client: stub as unknown as RelayClient, calls };
}

describe('RestDocumentProvider', () => {
  it('listDocuments unwraps the { documents } envelope', async () => {
    let invoked = 0;
    const { client } = makeStubClient({
      listDocuments: async () => {
        invoked++;
        return {
          documents: [
            { id: 'a' } as DocumentMetadata,
            { id: 'b' } as DocumentMetadata,
          ],
        };
      },
    });
    const provider = new RestDocumentProvider(client);
    const docs = await provider.listDocuments();
    expect(docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(invoked).toBe(1);
  });

  it('getDocument extracts serverVersion from the doc body', async () => {
    const { client } = makeStubClient();
    const provider = new RestDocumentProvider(client);
    const result = await provider.getDocument('doc-1');
    expect(result.serverVersion).toBe(3);
    expect(result.document.id).toBe('doc-1');
  });

  it('getDocument omits serverVersion when not present', async () => {
    const { client } = makeStubClient({
      getDocument: async (id: string) => ({ id, name: 'X' }) as unknown as DiagramDocument,
    });
    const provider = new RestDocumentProvider(client);
    const result = await provider.getDocument('doc-1');
    expect('serverVersion' in result).toBe(false);
  });

  it('saveDocument threads expectedVersion and returns { newVersion }', async () => {
    const { client, calls } = makeStubClient();
    const provider = new RestDocumentProvider(client);
    const doc = { id: 'doc-1' } as unknown as DiagramDocument;
    const result = await provider.saveDocument(doc, 9);
    expect(result).toEqual({ newVersion: 4 });
    expect(calls[0]).toEqual({ method: 'saveDocument', args: ['doc-1', doc, 9] });
  });

  it('saveDocument returns {} when relay does not echo a version', async () => {
    const { client } = makeStubClient({
      saveDocument: async () => ({ success: true }) as never,
    });
    const provider = new RestDocumentProvider(client);
    const result = await provider.saveDocument({ id: 'd' } as DiagramDocument);
    expect(result).toEqual({});
  });

  it('updateDocumentShares forwards the shares array', async () => {
    const { client, calls } = makeStubClient();
    const provider = new RestDocumentProvider(client);
    await provider.updateDocumentShares('doc-1', [
      { userId: 'u', userName: 'U', permission: 'editor' },
    ]);
    expect(calls[0]?.args[0]).toBe('doc-1');
    expect((calls[0]?.args[1] as unknown[])[0]).toMatchObject({ userId: 'u' });
  });

  it('transferDocumentOwnership forwards owner id+name', async () => {
    const { client, calls } = makeStubClient();
    const provider = new RestDocumentProvider(client);
    await provider.transferDocumentOwnership('doc-1', 'u-2', 'Bob');
    expect(calls[0]?.args).toEqual(['doc-1', 'u-2', 'Bob']);
  });
});
