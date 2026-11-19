import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OSM_ATTRIBUTION_HTML,
  OSM_ATTRIBUTION_TEXT,
  OSM_COPYRIGHT_URL,
  OSM_TILE_URL,
  TILE_LAYER_OPTIONS,
  parseCoordinates,
  toMapPlaces,
} from "@/lib/map-config";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** Source code with comments removed, so notes about the policy do not trip the checks. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("OpenStreetMap tile policy", () => {
  it("uses the standard OSM tile address with no query string or cache-busting", () => {
    expect(OSM_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(OSM_TILE_URL).not.toContain("?");
  });

  it("shows the required attribution: © OpenStreetMap contributors, linked to the copyright page", () => {
    expect(OSM_ATTRIBUTION_TEXT).toBe("© OpenStreetMap contributors");
    expect(OSM_COPYRIGHT_URL).toBe("https://www.openstreetmap.org/copyright");
    expect(OSM_ATTRIBUTION_HTML).toContain(OSM_COPYRIGHT_URL);
    expect(OSM_ATTRIBUTION_HTML).toMatch(/OpenStreetMap<\/a> contributors/);
    expect(TILE_LAYER_OPTIONS.attribution).toBe(OSM_ATTRIBUTION_HTML);
  });

  it("also prints the attribution as visible text under the map, not only inside it", () => {
    const component = code("components/trip-map.tsx");
    expect(component).toContain("OSM_ATTRIBUTION_TEXT");
    expect(component).toContain("OSM_COPYRIGHT_URL");
  });

  it("only loads tiles for what is on screen, and slowly while moving", () => {
    expect(TILE_LAYER_OPTIONS.updateWhenIdle).toBe(true);
    expect(TILE_LAYER_OPTIONS.updateWhenZooming).toBe(false);
    expect(TILE_LAYER_OPTIONS.keepBuffer).toBeLessThanOrEqual(2);
    expect(TILE_LAYER_OPTIONS.maxZoom).toBeLessThanOrEqual(19);
  });

  it("never fetches, prefetches or preloads tiles itself, and sets no cache headers", () => {
    for (const file of ["components/trip-map.tsx", "lib/map-config.ts"]) {
      const text = code(file);
      for (const forbidden of [
        /\bfetch\s*\(/, // no manual tile downloading
        /prefetch/i,
        /preload/i,
        /no-cache/i,
        /no-store/i,
        /cache-control/i,
        /referrerPolicy/i, // the Referer OSM asks for must not be switched off
        /no-referrer/i,
        /Date\.now\(\)/, // no timestamp cache-busting
      ]) {
        expect(text, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("the map only asks for tiles once there is something to pin", () => {
    const component = code("components/trip-map.tsx");
    expect(component).toMatch(/if \(!hasMap \|\| !element\) return;/);
  });
});

describe("parseCoordinates", () => {
  it("reads the formats you get from OpenStreetMap and Google Maps", () => {
    expect(parseCoordinates("15.2993, 74.1240")).toEqual({ ok: true, lat: 15.2993, lng: 74.124 });
    expect(parseCoordinates("15.2993,74.1240")).toEqual({ ok: true, lat: 15.2993, lng: 74.124 });
    expect(parseCoordinates("15.2993 74.1240")).toEqual({ ok: true, lat: 15.2993, lng: 74.124 });
    expect(parseCoordinates("-33.8688, 151.2093")).toEqual({ ok: true, lat: -33.8688, lng: 151.2093 });
  });

  it("rejects text, one number, and places outside the globe", () => {
    for (const bad of ["", "somewhere nice", "15.2993", "91, 10", "10, 181", "1,2,3"]) {
      expect(parseCoordinates(bad).ok).toBe(false);
    }
  });
});

describe("toMapPlaces", () => {
  const stays = [
    { id: "s1", name: "Villa Sol", url: "https://example.com/villa", latitude: "15.299300", longitude: "74.124000" },
    { id: "s2", name: "No pin yet", url: "https://example.com/other", latitude: null, longitude: null },
    { id: "s3", name: "Sneaky", url: "javascript:alert(1)", latitude: 15.3, longitude: 74.1 },
  ];
  const items = [
    { id: "i1", title: "Sunset at Chapora", place_url: "https://example.com/chapora", day_number: 2, time: "17:30:00", latitude: 15.6, longitude: 73.7 },
    { id: "i2", title: "Free evening", place_url: null, day_number: 3, time: null, latitude: null, longitude: null },
  ];
  const places = toMapPlaces(stays, items);

  it("turns database numbers (which arrive as text) into plain coordinates", () => {
    expect(places[0]).toMatchObject({ id: "stay-s1", kind: "stay", name: "Villa Sol", lat: 15.2993, lng: 74.124 });
  });

  it("includes every stay and every itinerary item", () => {
    expect(places.map((p) => p.name)).toEqual([
      "Villa Sol", "No pin yet", "Sneaky", "Sunset at Chapora", "Free evening",
    ]);
  });

  it("keeps places without a location, with no coordinates", () => {
    expect(places[1]).toMatchObject({ lat: null, lng: null });
    expect(places[4]).toMatchObject({ lat: null, lng: null, url: null });
  });

  it("describes itinerary items with day and time", () => {
    expect(places[3].detail).toBe("Day 2, 17:30");
    expect(places[4].detail).toBe("Day 3");
  });

  it("drops any source link that is not a plain web address", () => {
    expect(places[0].url).toBe("https://example.com/villa");
    expect(places[2].url).toBeNull();
  });
});
