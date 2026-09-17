import { describe, expect, test } from "bun:test";
import type { DataCategoryDeclaration } from "../data-category";
import type {
  AccessRequestResult,
  ErasureRequestResult,
  PortabilityRequestResult,
  RestrictionRequestResult,
} from "../data-subject-request";
import { deriveSubjectDigest } from "../subject-digest";
import type { DataSubjectRightsPort } from "./data-subject-rights";

const TENANT = "ten_aaaaaaaaaaaaaaaa";

// The acceptance proof of design §9: a new product adopts the port with the
// published types only — no product-specific contracts, no new types. This
// in-memory adopter stores rows per (tenant, subject identifier) and
// implements the six methods against a Map; it is the reference for what an
// implementation must look like from the outside.
function createInMemoryAdopter(): {
  port: DataSubjectRightsPort;
  seed(subjectIdentifier: string, rows: readonly string[]): void;
} {
  const rowsBySubject = new Map<string, string[]>();
  const erased = new Set<string>();
  const restricted = new Set<string>();
  let requestCounter = 0;
  const nextRequestId = () => {
    requestCounter += 1;
    return `dsr_mem_${requestCounter}`;
  };

  async function resolve(tenantId: string, subjectDigest: string): Promise<string | null> {
    for (const identifier of rowsBySubject.keys()) {
      if ((await deriveSubjectDigest(tenantId, identifier)) === subjectDigest) {
        return identifier;
      }
    }
    return null;
  }

  const port: DataSubjectRightsPort = {
    async verifySubject(tenantId, subjectIdentifier) {
      if (!rowsBySubject.has(subjectIdentifier)) {
        return null;
      }
      return deriveSubjectDigest(tenantId, subjectIdentifier);
    },
    async handleAccessRequest(tenantId, subjectDigest): Promise<AccessRequestResult> {
      const requestId = nextRequestId();
      if (erased.has(subjectDigest)) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.subject_erased" };
      }
      const identifier = await resolve(tenantId, subjectDigest);
      if (identifier === null) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.subject_unknown" };
      }
      return {
        status: "fulfilled",
        requestId,
        subjectDigest,
        dataExport: { rows: rowsBySubject.get(identifier) },
        exportedAt: "2026-07-23T12:00:00Z",
        categories: ["interaction"],
      };
    },
    async handleErasureRequest(tenantId, subjectDigest): Promise<ErasureRequestResult> {
      const requestId = nextRequestId();
      if (erased.has(subjectDigest)) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.already_erased" };
      }
      const identifier = await resolve(tenantId, subjectDigest);
      if (identifier === null) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.subject_unknown" };
      }
      const affected = rowsBySubject.get(identifier)?.length ?? 0;
      rowsBySubject.delete(identifier);
      erased.add(subjectDigest);
      return {
        status: "fulfilled",
        requestId,
        subjectDigest,
        erasedAt: "2026-07-23T12:00:00Z",
        deletionReceiptId: `rcpt_${requestId}`,
        recordsAffected: affected,
        categoriesErased: ["interaction"],
      };
    },
    async handleRestrictionRequest(
      tenantId,
      subjectDigest,
      ground,
    ): Promise<RestrictionRequestResult> {
      const requestId = nextRequestId();
      if (erased.has(subjectDigest)) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.subject_erased" };
      }
      if (restricted.has(subjectDigest)) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.already_restricted" };
      }
      const identifier = await resolve(tenantId, subjectDigest);
      if (identifier === null) {
        return { status: "refused", requestId, refusal: "test-product.rgpd.subject_unknown" };
      }
      restricted.add(subjectDigest);
      return {
        status: "fulfilled",
        requestId,
        restrictedAt: "2026-07-23T12:00:00Z",
        affectedRecords: rowsBySubject.get(identifier)?.length ?? 0,
        ground,
      };
    },
    async handlePortabilityRequest(): Promise<PortabilityRequestResult> {
      return {
        status: "refused",
        requestId: nextRequestId(),
        refusal: "test-product.rgpd.not_implemented",
      };
    },
    async listDataCategories(): Promise<readonly DataCategoryDeclaration[]> {
      return [
        {
          category: "interaction",
          description: "Rows held for the subject",
          legalBasis: "legitimate-interests",
          retentionRule: "test-rows",
          erasureScope: "immediate",
        },
      ];
    },
  };

  return {
    port,
    seed(subjectIdentifier, rows) {
      rowsBySubject.set(subjectIdentifier, [...rows]);
    },
  };
}

describe("DataSubjectRightsPort contract", () => {
  test("drives the full lifecycle through the port type alone", async () => {
    const { port, seed } = createInMemoryAdopter();
    seed("member-alice", ["row-1", "row-2"]);

    const digest = await port.verifySubject(TENANT, "member-alice");
    expect(digest).not.toBeNull();
    expect(await port.verifySubject(TENANT, "member-ghost")).toBeNull();

    const access = await port.handleAccessRequest(TENANT, digest as string);
    expect(access.status).toBe("fulfilled");
    if (access.status === "fulfilled") {
      expect(access.dataExport).toEqual({ rows: ["row-1", "row-2"] });
      expect(access.categories).toEqual(["interaction"]);
    }

    const erasure = await port.handleErasureRequest(TENANT, digest as string);
    expect(erasure.status).toBe("fulfilled");
    if (erasure.status === "fulfilled") {
      expect(erasure.recordsAffected).toBe(2);
      expect(erasure.deletionReceiptId).toStartWith("rcpt_");
    }

    const accessAfter = await port.handleAccessRequest(TENANT, digest as string);
    expect(accessAfter).toMatchObject({
      status: "refused",
      refusal: "test-product.rgpd.subject_erased",
    });

    const erasureAgain = await port.handleErasureRequest(TENANT, digest as string);
    expect(erasureAgain).toMatchObject({
      status: "refused",
      refusal: "test-product.rgpd.already_erased",
    });
  });

  test("portability remains a deferred right, refusing with a typed code instead of throwing", async () => {
    const { port, seed } = createInMemoryAdopter();
    seed("member-alice", ["row-1"]);
    const digest = (await port.verifySubject(TENANT, "member-alice")) as string;
    expect(await port.handlePortabilityRequest(TENANT, digest)).toMatchObject({
      status: "refused",
      refusal: "test-product.rgpd.not_implemented",
    });
  });

  test("restriction: unknown subject refuses subject_unknown", async () => {
    const { port } = createInMemoryAdopter();
    const ghostDigest = await deriveSubjectDigest(TENANT, "member-ghost");
    expect(
      await port.handleRestrictionRequest(TENANT, ghostDigest, "accuracy-contested"),
    ).toMatchObject({
      status: "refused",
      refusal: "test-product.rgpd.subject_unknown",
    });
  });

  test("restriction: an erased subject refuses subject_erased", async () => {
    const { port, seed } = createInMemoryAdopter();
    seed("member-alice", ["row-1"]);
    const digest = (await port.verifySubject(TENANT, "member-alice")) as string;
    await port.handleErasureRequest(TENANT, digest);
    expect(await port.handleRestrictionRequest(TENANT, digest, "accuracy-contested")).toMatchObject(
      {
        status: "refused",
        refusal: "test-product.rgpd.subject_erased",
      },
    );
  });

  test("restriction: first request fulfills and echoes the ground", async () => {
    const { port, seed } = createInMemoryAdopter();
    seed("member-alice", ["row-1", "row-2"]);
    const digest = (await port.verifySubject(TENANT, "member-alice")) as string;
    const result = await port.handleRestrictionRequest(TENANT, digest, "accuracy-contested");
    expect(result).toMatchObject({
      status: "fulfilled",
      ground: "accuracy-contested",
      affectedRecords: 2,
    });
  });

  test("restriction: a second request while restricted refuses already_restricted", async () => {
    const { port, seed } = createInMemoryAdopter();
    seed("member-alice", ["row-1"]);
    const digest = (await port.verifySubject(TENANT, "member-alice")) as string;
    await port.handleRestrictionRequest(TENANT, digest, "accuracy-contested");
    expect(await port.handleRestrictionRequest(TENANT, digest, "objection-pending")).toMatchObject({
      status: "refused",
      refusal: "test-product.rgpd.already_restricted",
    });
  });

  test("declared categories validate against the shared declaration shape", async () => {
    const { port } = createInMemoryAdopter();
    const declarations = await port.listDataCategories(TENANT, "c".repeat(64));
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.category).toBe("interaction");
  });
});
