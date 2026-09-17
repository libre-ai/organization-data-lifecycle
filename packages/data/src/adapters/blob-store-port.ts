/**
 * Cellar-class blob store port (DATA-LIFECYCLE store classes: "explicit
 * artifact/export/evidence blobs — EU bucket, server-side encryption, digest
 * and owner metadata"). Deletion is enqueue-only and content-addressed
 * (explicit-deletion step 3): the store never receives row content, only
 * digests. The real Cellar client arrives with G4 provisioning.
 */
export interface BlobMetadata {
  readonly owner: string;
  readonly tenantId: string;
}

export interface BlobStorePort {
  put(digest: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<void>;
  /** Enqueue content-addressed deletion; returns the digests actually enqueued (those that exist). */
  enqueueContentAddressedDeletion(digests: readonly string[]): Promise<string[]>;
}

export class InMemoryBlobStore implements BlobStorePort {
  private readonly blobs = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>();
  private readonly deletionQueue: string[] = [];

  async put(digest: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<void> {
    this.blobs.set(digest, { bytes, metadata });
  }

  async enqueueContentAddressedDeletion(digests: readonly string[]): Promise<string[]> {
    const enqueued: string[] = [];
    for (const digest of digests) {
      if (this.blobs.has(digest)) {
        this.deletionQueue.push(digest);
        enqueued.push(digest);
      }
    }
    return enqueued;
  }

  pendingDeletions(): string[] {
    return [...this.deletionQueue];
  }
}
