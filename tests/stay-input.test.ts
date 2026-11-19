import { describe, expect, it } from "vitest";
import { parseStayInput, safeHttpUrl } from "@/lib/stay-input";

const TODAY = "2026-11-19";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const valid = {
  name: "Villa Sol",
  url: "https://example.com/villa-sol",
  nightly: "12,000",
  taxes: "5760",
  fees: "1500",
  rooms: "3",
  beds: "6",
  distance_km: "2.5",
  cancellation_type: "non_refundable",
  cancellation_terms: "Pay in full now, no refund",
  price_checked_on: "2026-11-18",
};

describe("parseStayInput", () => {
  it("turns rupees into integer paise and keeps everything else", () => {
    const result = parseStayInput(form(valid), TODAY);
    expect(result).toEqual({
      ok: true,
      data: {
        name: "Villa Sol",
        url: "https://example.com/villa-sol",
        nightly_price_paise: 1_200_000,
        taxes_paise: 576_000,
        fees_paise: 150_000,
        cancellation_type: "non_refundable",
        cancellation_terms: "Pay in full now, no refund",
        rooms: 3,
        beds: 6,
        distance_km: 2.5,
        price_checked_on: "2026-11-18",
        latitude: null,
        longitude: null,
      },
    });
  });

  it("reads an optional map location as latitude and longitude", () => {
    const result = parseStayInput(form({ ...valid, location: "15.2993, 74.1240" }), TODAY);
    expect(result.ok && [result.data.latitude, result.data.longitude]).toEqual([15.2993, 74.124]);

    const bad = parseStayInput(form({ ...valid, location: "somewhere nice" }), TODAY);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.location).toMatch(/latitude, longitude/);
  });

  it("treats missing taxes, fees and distance as zero or unknown", () => {
    const result = parseStayInput(
      form({ ...valid, taxes: "", fees: "", distance_km: "", cancellation_terms: "" }),
      TODAY,
    );
    expect(result.ok && result.data).toMatchObject({
      taxes_paise: 0,
      fees_paise: 0,
      distance_km: null,
      cancellation_terms: null,
    });
  });

  it("rejects a missing price, bad rooms and a future check date", () => {
    const result = parseStayInput(
      form({ ...valid, nightly: "", rooms: "0", price_checked_on: "2026-11-20" }),
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(
        ["nightly", "price_checked_on", "rooms"].sort(),
      );
    }
  });

  it("rejects an unknown cancellation type and a negative price", () => {
    expect(parseStayInput(form({ ...valid, cancellation_type: "maybe" }), TODAY).ok).toBe(false);
    expect(parseStayInput(form({ ...valid, nightly: "-5" }), TODAY).ok).toBe(false);
  });
});

describe("safeHttpUrl", () => {
  it("keeps normal web links", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("refuses links that could run code or leave the web", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });

  it("is also what the form uses, so a javascript: link cannot be saved", () => {
    const result = parseStayInput(form({ ...valid, url: "javascript:alert(1)" }), TODAY);
    expect(result.ok).toBe(false);
  });
});
