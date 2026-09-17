import { describe, expect, test } from "bun:test";
import {
  DATA_CATEGORIES,
  ERASURE_SCOPES,
  InvalidDataCategoryDeclarationError,
  LEGAL_BASES,
  validateDataCategoryDeclaration,
} from "./data-category";

const DECLARATION = {
  category: "communication",
  description: "Conversation text and structured contributions",
  legalBasis: "contract",
  retentionRule: "sessions-content",
  erasureScope: "deferred",
};

describe("data-category taxonomy", () => {
  test("exposes the nine locked categories", () => {
    expect(DATA_CATEGORIES).toEqual([
      "identity",
      "contact",
      "profile-preference",
      "interaction",
      "communication",
      "evaluation",
      "special-category",
      "timestamp",
      "audit",
    ]);
  });

  test("exposes the six Art. 6(1) legal bases and three erasure scopes", () => {
    expect(LEGAL_BASES).toEqual([
      "consent",
      "contract",
      "legal-obligation",
      "vital-interests",
      "public-task",
      "legitimate-interests",
    ]);
    expect(ERASURE_SCOPES).toEqual(["immediate", "deferred", "never"]);
  });
});

describe("validateDataCategoryDeclaration", () => {
  test("accepts a complete declaration and returns a typed copy", () => {
    const declaration = validateDataCategoryDeclaration(DECLARATION);
    expect(declaration).toEqual({
      category: "communication",
      description: "Conversation text and structured contributions",
      legalBasis: "contract",
      retentionRule: "sessions-content",
      erasureScope: "deferred",
    });
  });

  test("rejects a non-object input", () => {
    expect(() => validateDataCategoryDeclaration(null)).toThrow(
      InvalidDataCategoryDeclarationError,
    );
    expect(() => validateDataCategoryDeclaration("communication")).toThrow(
      InvalidDataCategoryDeclarationError,
    );
  });

  test("rejects an unknown category", () => {
    expect(() =>
      validateDataCategoryDeclaration({ ...DECLARATION, category: "biometric" }),
    ).toThrow(InvalidDataCategoryDeclarationError);
  });

  test("rejects an unknown legal basis", () => {
    expect(() =>
      validateDataCategoryDeclaration({ ...DECLARATION, legalBasis: "curiosity" }),
    ).toThrow(InvalidDataCategoryDeclarationError);
  });

  test("rejects an unknown erasure scope", () => {
    expect(() =>
      validateDataCategoryDeclaration({ ...DECLARATION, erasureScope: "someday" }),
    ).toThrow(InvalidDataCategoryDeclarationError);
  });

  test("rejects an empty description", () => {
    expect(() => validateDataCategoryDeclaration({ ...DECLARATION, description: "  " })).toThrow(
      InvalidDataCategoryDeclarationError,
    );
  });

  test("rejects a malformed retention rule id", () => {
    for (const retentionRule of ["", "Sessions-Content", "sessions content", "9days"]) {
      expect(() => validateDataCategoryDeclaration({ ...DECLARATION, retentionRule })).toThrow(
        InvalidDataCategoryDeclarationError,
      );
    }
  });

  test("names the failing field without echoing free-text values", () => {
    expect(() =>
      validateDataCategoryDeclaration({ ...DECLARATION, description: "secret@example.com" }),
    ).not.toThrow();
    try {
      validateDataCategoryDeclaration({ ...DECLARATION, retentionRule: "user@example.com" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDataCategoryDeclarationError);
      expect((error as Error).message).toContain("retentionRule");
      expect((error as Error).message).not.toContain("user@example.com");
    }
  });
});
