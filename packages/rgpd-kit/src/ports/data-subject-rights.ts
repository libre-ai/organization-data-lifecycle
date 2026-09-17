// The port every PII-bearing product implements to expose its data-subject
// rights handlers (design §4.2, option A). The port is the ONLY coupling
// surface between rgpd-kit and a product: rgpd-kit owns the types, the
// product owns its data, migrations, deletion queries and receipts inside
// its bounded context. There is no orchestrator, no shared table, no
// cross-context transaction — a request affects one product at a time.
//
// AUTHORIZATION PRECONDITION: callers authorize the actor, tenant and scope
// BEFORE invoking any method here (deny-by-default), the same boundary as
// @libre-ai/data executeActiveDeletion. Reaching a port method means that
// gate already passed; implementations still fail closed on unknown or
// already-erased subjects with typed refusals.
//
// PII rule (design Appendix B): every method past verification speaks in
// opaque subject digests. The plaintext identifier appears once, in
// `verifySubject`, and is never persisted by any conforming implementation.

import type { DataCategoryDeclaration } from "../data-category";
import type {
  AccessRequestResult,
  ErasureRequestResult,
  PortabilityRequestResult,
  RestrictionGround,
  RestrictionRequestResult,
} from "../data-subject-request";

export interface DataSubjectRightsPort {
  /**
   * Verify that the identifier names a real subject of this product inside
   * the tenant. Returns the opaque tenant-scoped digest (subject-digest.ts)
   * when verified, null when unverifiable — never an error revealing whether
   * the identifier exists elsewhere.
   */
  verifySubject(tenantId: string, subjectIdentifier: string): Promise<string | null>;

  /** Art. 15 — export every record held for the subject, structured. */
  handleAccessRequest(tenantId: string, subjectDigest: string): Promise<AccessRequestResult>;

  /**
   * Art. 17 — erase the subject's data inside one accepted transaction and
   * persist the product-owned deletion receipt (@libre-ai/data
   * executeActiveDeletion). Append-only stores erase by removing logical
   * access in that transaction; physical compaction follows the retention
   * path (DATA-LIFECYCLE §Explicit deletion).
   */
  handleErasureRequest(tenantId: string, subjectDigest: string): Promise<ErasureRequestResult>;

  /**
   * Art. 18 — pause processing while keeping the data. `ground` is one of
   * the Art. 18(1) grounds: it belongs to the subject and enters through the
   * request, never invented by the implementation.
   */
  handleRestrictionRequest(
    tenantId: string,
    subjectDigest: string,
    ground: RestrictionGround,
  ): Promise<RestrictionRequestResult>;

  /** Art. 20 — export in an interoperable format for another controller. */
  handlePortabilityRequest(
    tenantId: string,
    subjectDigest: string,
  ): Promise<PortabilityRequestResult>;

  /** Categories held for the subject (Art. 30 register and accountability). */
  listDataCategories(
    tenantId: string,
    subjectDigest: string,
  ): Promise<readonly DataCategoryDeclaration[]>;
}
