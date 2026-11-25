import { describe, expect, it } from "vitest";
import {
  dayLabel,
  dayWarnings,
  distancesFromPrevious,
  parseStopForm,
  stopStatus,
  tripDays,
  type Stop,
} from "@/lib/itinerary";

const stop = (id: string, time: string, duration: number, extra: Partial<Stop> = {}): Stop => ({
  id,
  day: 1,
  time,
  duration,
  title: id,
  placeUrl: null,
  lat: null,
  lng: null,
  costMinor: null,
  notes: null,
  createdBy: null,
  ...extra,
});

describe("stopStatus", () => {
  it("is agreed only when every current member is for it", () => {
    expect(stopStatus({ a: "for", b: "for" }, ["a", "b"])).toBe("agreed");
    expect(stopStatus({ a: "for" }, ["a", "b"])).toBe("proposed");
    expect(stopStatus({ a: "for", b: "against" }, ["a", "b"])).toBe("contested");
    expect(stopStatus({ a: "for", gone: "against" }, ["a"])).toBe("agreed"); // former member ignored
  });
});

describe("dayWarnings", () => {
  it("flags overlaps and stops past midnight, in words", () => {
    const w = dayWarnings([stop("Lunch", "13:00", 90), stop("Fort", "14:00", 60), stop("Party", "23:00", 120)]);
    expect(w.map((x) => x.message)).toEqual([
      "Fort starts at 14:00, before Lunch ends at 14:30.",
      "Party runs past midnight (ends 01:00 the next day).",
    ]);
  });
  it("is quiet when stops fit", () => {
    expect(dayWarnings([stop("A", "09:00", 60), stop("B", "10:00", 60)])).toEqual([]);
  });
});

describe("distancesFromPrevious", () => {
  it("gives straight-line km between consecutive located stops only", () => {
    const d = distancesFromPrevious([
      stop("A", "09:00", 60, { lat: 15.5, lng: 73.8 }),
      stop("B", "11:00", 60),
      stop("C", "13:00", 60, { lat: 15.6, lng: 73.8 }),
    ]);
    expect(Object.keys(d)).toEqual(["C"]);
    expect(d.C).toBeCloseTo(11.12, 1);
  });
});

describe("days", () => {
  it("labels days from date-only trip dates", () => {
    expect(dayLabel(2, "2027-02-05")).toBe("Day 2 · Sat 6 Feb");
    expect(dayLabel(3, null)).toBe("Day 3");
    expect(tripDays("2027-02-05", "2027-02-08")).toBe(4);
    expect(tripDays(null, null)).toBeNull();
  });
});

describe("parseStopForm", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const base = { day: "2", time: "10:30", duration: "90", title: " Fort ", cost: "450", notes: "" };
  it("returns clean values with minor-unit cost", () => {
    expect(parseStopForm(form({ ...base, coordinates: "15.4920, 73.7730", place_url: "https://maps.example/x" }), 4)).toEqual({
      ok: true,
      data: { day: 2, time: "10:30", duration: 90, title: "Fort", placeUrl: "https://maps.example/x", lat: 15.492, lng: 73.773, costMinor: 45000, notes: null, travelMinutes: null, placeId: null },
    });
  });
  it("rejects bad days, times, durations, links and coordinates", () => {
    expect(parseStopForm(form({ ...base, day: "5" }), 4).ok).toBe(false);
    expect(parseStopForm(form({ ...base, time: "25:00" }), 4).ok).toBe(false);
    expect(parseStopForm(form({ ...base, duration: "2" }), 4).ok).toBe(false);
    expect(parseStopForm(form({ ...base, place_url: "javascript:alert(1)" }), 4).ok).toBe(false);
    expect(parseStopForm(form({ ...base, coordinates: "999, 1" }), 4).ok).toBe(false);
    expect(parseStopForm(form({ ...base, travel_minutes: "-5" }), 4).ok).toBe(false);
    const withTravel = parseStopForm(form({ ...base, travel_minutes: "25" }), 4);
    expect(withTravel.ok && withTravel.data.travelMinutes).toBe(25);
  });
});
