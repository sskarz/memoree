import { describe, it, expect } from "vitest";
import { embeddingSqlLiteral } from "../../src/embeddings/sql.js";

describe("embeddingSqlLiteral", () => {
  it("returns NULL for null input", () => {
    expect(embeddingSqlLiteral(null)).toBe("NULL");
  });

  it("returns NULL for undefined", () => {
    expect(embeddingSqlLiteral(undefined)).toBe("NULL");
  });

  it("returns NULL for empty array", () => {
    expect(embeddingSqlLiteral([])).toBe("NULL");
  });

  it("returns a PostgreSQL double-precision array for a vector", () => {
    expect(embeddingSqlLiteral([0.1, 0.2, -0.3])).toBe("ARRAY[0.1,0.2,-0.3]::double precision[]");
  });

  it("returns NULL if any element is NaN / Infinity", () => {
    expect(embeddingSqlLiteral([0.1, NaN, 0.3])).toBe("NULL");
    expect(embeddingSqlLiteral([0.1, Infinity, 0.3])).toBe("NULL");
    expect(embeddingSqlLiteral([-Infinity, 0.1])).toBe("NULL");
  });

  it("uses shortest round-trip representation (no toFixed truncation)", () => {
    // A value that toFixed(6) would round is preserved
    const vec = [0.123456789];
    expect(embeddingSqlLiteral(vec)).toBe("ARRAY[0.123456789]::double precision[]");
  });

  it("handles a realistic 768-dim vector without truncation", () => {
    const vec = Array.from({ length: 768 }, (_, i) => i / 1000);
    const sql = embeddingSqlLiteral(vec);
    expect(sql.startsWith("ARRAY[")).toBe(true);
    expect(sql.endsWith("]::double precision[]")).toBe(true);
    // Count commas → 767 separators → 768 elements
    const commas = (sql.match(/,/g) ?? []).length;
    expect(commas).toBe(767);
  });
});
