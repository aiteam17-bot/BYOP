// Settings and helpers for the trip map. No browser code here, so it can be
// unit-tested.
//
// OpenStreetMap tile usage policy (operations.osmfoundation.org/policies/tiles/),
// and how this app follows it:
//   * Attribution: the "© OpenStreetMap contributors" line, linked to the
//     copyright page, is shown on the map AND in plain text under it.
//   * No bulk downloading and no prefetching: tiles are requested only for the
//     part of the map the person is looking at. Nothing is requested ahead of
//     time, in the background, or for areas that are off screen.
//   * No no-cache headers: this app sets none on tile requests, and tile URLs
//     carry no cache-busting parameters, so the browser's normal HTTP cache
//     (which the OSM servers allow) is used.
//   * A valid Referer is sent: browsers send one by default and the app never
//     turns it off.
//   * Light use only. If this app ever grows beyond a small group, switch to a
//     commercial tile provider instead of the free OSM servers.

import { safeHttpUrl } from "@/lib/url";

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

export const OSM_ATTRIBUTION_TEXT = "© OpenStreetMap contributors";
export const OSM_ATTRIBUTION_HTML = `&copy; <a href="${OSM_COPYRIGHT_URL}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors`;

export const TILE_LAYER_OPTIONS = {
  attribution: OSM_ATTRIBUTION_HTML,
  maxZoom: 19,
  // Fewer requests while panning and zooming: only load once movement settles,
  // and never load throw-away tiles for the in-between zoom levels.
  updateWhenIdle: true,
  updateWhenZooming: false,
  // Keep tiles just outside the view in memory, but do not fetch them early.
  keepBuffer: 1,
} as const;

/** Closest zoom when framing the pins, so a single pin is not zoomed to street level. */
export const MAX_FIT_ZOOM = 15;

export type MapPlace = {
  id: string;
  kind: "stay" | "itinerary";
  name: string; // shown in the popup and the list
  detail: string | null; // e.g. "Day 2, 09:30"
  url: string | null; // source link: only ever a safe http(s) address
  lat: number | null;
  lng: number | null;
};

/**
 * Reads "15.2993, 74.1240" (also "15.2993 74.1240" or "15.2993,74.1240"), the
 * format you get by right-clicking a point in OpenStreetMap or Google Maps.
 */
export function parseCoordinates(
  raw: string,
): { ok: true; lat: number; lng: number } | { ok: false; error: string } {
  const match = raw
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) {
    return {
      ok: false,
      error: "Enter the location as latitude, longitude, like 15.2993, 74.1240",
    };
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: "That location is outside the map" };
  }
  // The database keeps 6 decimal places (about 10 cm).
  return { ok: true, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

type StayRow = {
  id: string;
  name: string;
  url: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

type ItineraryRow = {
  id: string;
  title: string;
  place_url: string | null;
  day_number: number;
  time: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
};

function coordinate(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Turns database rows into map places. Links that are not plain http(s) are dropped. */
export function toMapPlaces(stays: StayRow[], items: ItineraryRow[]): MapPlace[] {
  const stayPlaces: MapPlace[] = stays.map((s) => ({
    id: `stay-${s.id}`,
    kind: "stay",
    name: s.name,
    detail: "Stay",
    url: safeHttpUrl(s.url),
    lat: coordinate(s.latitude),
    lng: coordinate(s.longitude),
  }));

  const itineraryPlaces: MapPlace[] = items.map((i) => ({
    id: `itinerary-${i.id}`,
    kind: "itinerary",
    name: i.title,
    detail: `Day ${i.day_number}${i.time ? `, ${i.time.slice(0, 5)}` : ""}`,
    url: safeHttpUrl(i.place_url),
    lat: coordinate(i.latitude),
    lng: coordinate(i.longitude),
  }));

  return [...stayPlaces, ...itineraryPlaces];
}
