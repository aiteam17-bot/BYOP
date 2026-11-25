import { describe, expect, it } from "vitest";
import { parseQuoteForm } from "@/lib/quote-input";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const base = {
  name: "Villa Sol",
  source_url: "https://example.com/v",
  pricing_basis: "per_room_per_night",
  currency: "INR",
  quoted_amount: "6,000",
  nights: "3",
  rooms: "2",
  sharers: "5",
  taxes: "",
  fees: "1500",
  checked_at: "2026-11-20T10:00",
};

describe("parseQuoteForm", () => {
  it("keeps blank taxes as unknown (null), not zero, and stores minor units", () => {
    const r = parseQuoteForm(form(base), "INR", "Asia/Kolkata");
    expect(r.ok && r.data).toMatchObject({
      quoted_amount_minor: 600000,
      taxes_minor: null,
      fees_minor: 150000,
      checked_at: "2026-11-20T04:30:00.000Z",
      fx_rate_micros: null,
    });
  });
  it("needs a basis, a source, and a full conversion for other currencies", () => {
    expect(parseQuoteForm(form({ ...base, pricing_basis: "" }), "INR", "Asia/Kolkata").ok).toBe(false);
    expect(parseQuoteForm(form({ ...base, source_url: "javascript:x" }), "INR", "Asia/Kolkata").ok).toBe(false);
    expect(parseQuoteForm(form({ ...base, currency: "USD", fx_rate: "83.1" }), "INR", "Asia/Kolkata").ok).toBe(false);
    const ok = parseQuoteForm(form({ ...base, currency: "USD", fx_rate: "83.125", fx_rate_date: "2026-11-20", fx_source: "RBI" }), "INR", "Asia/Kolkata");
    expect(ok.ok && ok.data.fx_rate_micros).toBe(83125000);
    expect(parseQuoteForm(form({ ...base, fx_rate: "1", fx_rate_date: "2026-11-20", fx_source: "x" }), "INR", "Asia/Kolkata").ok).toBe(false);
  });
  it("stores a cancellation deadline as an instant with its zone", () => {
    const r = parseQuoteForm(form({ ...base, cancellation_deadline: "2027-02-01T18:00", cancellation_tz: "Asia/Kolkata" }), "INR", "Asia/Kolkata");
    expect(r.ok && [r.data.cancellation_deadline, r.data.cancellation_tz]).toEqual(["2027-02-01T12:30:00.000Z", "Asia/Kolkata"]);
  });
  it("rejects a checked time in the future and fractional counts", () => {
    expect(parseQuoteForm(form({ ...base, checked_at: "2099-01-01T10:00" }), "INR", "Asia/Kolkata").ok).toBe(false);
    expect(parseQuoteForm(form({ ...base, rooms: "1.5" }), "INR", "Asia/Kolkata").ok).toBe(false);
  });
});
