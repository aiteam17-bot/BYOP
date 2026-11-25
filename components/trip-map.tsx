"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  MAX_FIT_ZOOM,
  OSM_ATTRIBUTION_TEXT,
  OSM_COPYRIGHT_URL,
  OSM_TILE_URL,
  TILE_LAYER_OPTIONS,
  type MapPlace,
} from "@/lib/map-config";

// How long to wait for the first map tile before giving up and showing the list.
const TILE_TIMEOUT_MS = 10_000;

const PIN_COLOURS = { stay: "#2563eb", itinerary: "#ea580c" } as const;

function pinHtml(kind: MapPlace["kind"]): string {
  // Fixed text only: nothing from the database is ever put into this string.
  return `<span style="display:block;width:22px;height:22px;border-radius:9999px;background:${PIN_COLOURS[kind]};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.55)"></span>`;
}

/** Popup built from DOM nodes and textContent, so a place name can never inject HTML. */
function popupContent(place: MapPlace): HTMLElement {
  const box = document.createElement("div");
  box.style.minWidth = "140px";

  const title = document.createElement("strong");
  title.textContent = place.name;
  box.appendChild(title);

  if (place.detail) {
    const detail = document.createElement("div");
    detail.textContent = place.detail;
    detail.style.color = "#52525b";
    box.appendChild(detail);
  }

  if (place.url) {
    const link = document.createElement("a");
    link.href = place.url; // already checked to be a plain http(s) address
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    link.textContent = "Open source link ↗";
    link.style.display = "inline-block";
    link.style.marginTop = "4px";
    box.appendChild(link);
  }
  return box;
}

export function PlaceList({ places }: { places: MapPlace[] }) {
  if (places.length === 0) return null;
  return (
    <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
      {places.map((place) => (
        <li key={place.id} className="flex flex-col gap-0.5 py-2.5">
          <span className="font-medium text-zinc-950 dark:text-zinc-50">
            {place.name}
          </span>
          <span className="text-sm text-zinc-500">
            {place.detail}
            {place.lat === null && " · no map location yet"}
          </span>
          {place.url && (
            <a
              href={place.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-sm text-blue-700 underline dark:text-blue-400"
            >
              Open source link ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export type Connector = { from: [number, number]; to: [number, number] };

export function TripMap({ places, connectors = [] }: { places: MapPlace[]; connectors?: Connector[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  const located = places.filter((p) => p.lat !== null && p.lng !== null);
  const unlocated = places.filter((p) => p.lat === null || p.lng === null);
  const hasMap = located.length > 0;

  useEffect(() => {
    const element = container.current;
    if (!hasMap || !element) return;

    let cancelled = false;
    let map: LeafletMap | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const leafletModule = await import("leaflet");
        const L =
          (leafletModule as unknown as { default?: typeof leafletModule }).default ??
          leafletModule;
        if (cancelled) return;

        map = L.map(element, { scrollWheelZoom: false });

        let tilesLoaded = 0;
        const tiles = L.tileLayer(OSM_TILE_URL, { ...TILE_LAYER_OPTIONS });
        tiles.on("tileload", () => {
          tilesLoaded += 1;
          if (!cancelled) setStatus("ready");
        });
        tiles.addTo(map);

        const bounds = L.latLngBounds([]);
        for (const place of located) {
          const point: [number, number] = [place.lat!, place.lng!];
          bounds.extend(point);
          L.marker(point, {
            title: place.name,
            icon: L.divIcon({
              className: "",
              html: pinHtml(place.kind),
              iconSize: [22, 22],
              iconAnchor: [11, 11],
              popupAnchor: [0, -12],
            }),
          })
            .bindPopup(popupContent(place))
            .addTo(map);
        }

        // Schematic only: straight dashed lines in visiting order, not routes.
        for (const c of connectors) {
          L.polyline([c.from, c.to], { color: "#71717a", weight: 2, dashArray: "6 6", interactive: false }).addTo(map);
        }

        if (located.length === 1) {
          map.setView(bounds.getCenter(), MAX_FIT_ZOOM);
        } else {
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: MAX_FIT_ZOOM });
        }

        // No tile at all after a while means the tile server is unreachable.
        timer = setTimeout(() => {
          if (tilesLoaded === 0 && !cancelled) setStatus("failed");
        }, TILE_TIMEOUT_MS);
      } catch {
        if (!cancelled) setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      map?.remove();
    };
    // `located` is derived from `places`, which is what should restart the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, connectors, hasMap]);

  if (places.length === 0) {
    return (
      <p className="text-base text-zinc-600 dark:text-zinc-400">
        Nothing to show on the map yet. Add a map location to a stay, place or
        stop and it will appear here.
      </p>
    );
  }

  // Fallback: the map could not load, so show every place as a plain list.
  if (status === "failed") {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-base text-zinc-700 dark:text-zinc-300">
          The map couldn&apos;t load, so here are the places as a list.
        </p>
        <PlaceList places={places} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasMap ? (
        <>
          <div
            ref={container}
            role="region"
            aria-label="Map of stays and itinerary items"
            className="relative z-0 h-[420px] w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 max-md:h-[320px]"
          />
          {status === "loading" && (
            <p className="text-sm text-zinc-500">Loading the map…</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ background: PIN_COLOURS.stay }} />
                Stays
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ background: PIN_COLOURS.itinerary }} />
                Itinerary
              </span>
            </span>
            {connectors.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-5 border-t-2 border-dashed border-zinc-500" />
                Schematic order of stops: straight lines, not routes or travel times
              </span>
            )}
            {/* Always visible, as the OpenStreetMap licence requires. */}
            <a
              href={OSM_COPYRIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {OSM_ATTRIBUTION_TEXT}
            </a>
          </div>
        </>
      ) : (
        <p className="text-base text-zinc-600 dark:text-zinc-400">
          None of these places has a map location yet, so there is nothing to
          pin. Add a location when you add a stay.
        </p>
      )}

      {unlocated.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Not on the map yet
          </p>
          <PlaceList places={unlocated} />
        </div>
      )}
    </div>
  );
}
