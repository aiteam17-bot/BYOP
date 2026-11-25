import { describe, expect, it } from "vitest";
import { formatInZone, isoToZonedLocal, zonedLocalToIso } from "@/lib/zoned";

describe("zoned wall clock <-> instant", () => {
  it("converts local times in named zones, including DST", () => {
    expect(zonedLocalToIso("2027-02-01T18:00", "Asia/Kolkata")).toBe("2027-02-01T12:30:00.000Z");
    expect(zonedLocalToIso("2027-07-01T09:00", "Europe/London")).toBe("2027-07-01T08:00:00.000Z"); // BST
    expect(zonedLocalToIso("2027-01-01T09:00", "Europe/London")).toBe("2027-01-01T09:00:00.000Z");
  });
  it("rejects malformed input, impossible dates and unknown zones", () => {
    expect(zonedLocalToIso("2027-02-30T10:00", "UTC")).toBeNull();
    expect(zonedLocalToIso("tomorrow", "UTC")).toBeNull();
    expect(zonedLocalToIso("2027-02-01T10:00", "Mars/Base")).toBeNull();
  });
  it("round-trips for form defaults and formats with the zone name", () => {
    const iso = "2027-02-01T12:30:00.000Z";
    expect(isoToZonedLocal(iso, "Asia/Kolkata")).toBe("2027-02-01T18:00");
    expect(formatInZone(iso, "Asia/Kolkata")).toMatch(/1 Feb 2027.*18:00.*Asia\/Kolkata/);
  });
});
