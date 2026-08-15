import type { City, GroundStation, HubEdge } from "./types";

/**
 * Simplified, illustrative geography for the visualisation.
 *
 * These are real places, and the backbone edges below trace the rough
 * corridors real submarine/terrestrial cables follow, but the graph itself
 * (which hubs connect to which) is a hand-simplified stand-in for the actual
 * global routing table -- not a live or exact map of any operator's network.
 * See CLAUDE.md "Avoid fake precision".
 */

// Cities that double as backbone hubs (major IXPs / cable landing points) are
// listed once here and tagged with every role they play.
export const CITIES: readonly City[] = [
  // --- hub + server cities (major IXPs / cloud regions) ---
  { id: "nyc", name: "New York", country: "United States", lat: 40.71, lon: -74.01, kinds: ["origin", "hub", "server"] },
  { id: "lax", name: "Los Angeles", country: "United States", lat: 34.05, lon: -118.24, kinds: ["origin", "hub", "server"] },
  { id: "mia", name: "Miami", country: "United States", lat: 25.76, lon: -80.19, kinds: ["origin", "hub"] },
  { id: "pty", name: "Panama City", country: "Panama", lat: 8.98, lon: -79.52, kinds: ["hub"] },
  { id: "sao", name: "São Paulo", country: "Brazil", lat: -23.55, lon: -46.63, kinds: ["origin", "hub", "server"] },
  { id: "lon", name: "London", country: "United Kingdom", lat: 51.51, lon: -0.13, kinds: ["origin", "hub", "server"] },
  { id: "par", name: "Paris", country: "France", lat: 48.85, lon: 2.35, kinds: ["origin", "hub"] },
  { id: "mrs", name: "Marseille", country: "France", lat: 43.3, lon: 5.37, kinds: ["hub"] },
  { id: "ams", name: "Amsterdam", country: "Netherlands", lat: 52.37, lon: 4.9, kinds: ["origin", "hub", "server"] },
  { id: "fra", name: "Frankfurt", country: "Germany", lat: 50.11, lon: 8.68, kinds: ["origin", "hub", "server"] },
  { id: "dxb", name: "Dubai", country: "United Arab Emirates", lat: 25.2, lon: 55.27, kinds: ["origin", "hub", "server"] },
  { id: "mum", name: "Mumbai", country: "India", lat: 19.08, lon: 72.88, kinds: ["origin", "hub", "server"] },
  { id: "sin", name: "Singapore", country: "Singapore", lat: 1.35, lon: 103.82, kinds: ["origin", "hub", "server"] },
  { id: "hkg", name: "Hong Kong", country: "China", lat: 22.32, lon: 114.17, kinds: ["origin", "hub", "server"] },
  { id: "tyo", name: "Tokyo", country: "Japan", lat: 35.68, lon: 139.69, kinds: ["origin", "hub", "server"] },
  { id: "syd", name: "Sydney", country: "Australia", lat: -33.87, lon: 151.21, kinds: ["origin", "hub", "server"] },
  { id: "cpt", name: "Cape Town", country: "South Africa", lat: -33.92, lon: 18.42, kinds: ["origin", "hub"] },

  // --- other origin-selectable cities, each nearest to a hub above ---
  { id: "tor", name: "Toronto", country: "Canada", lat: 43.65, lon: -79.38, kinds: ["origin"] },
  { id: "chi", name: "Chicago", country: "United States", lat: 41.88, lon: -87.63, kinds: ["origin"] },
  { id: "van", name: "Vancouver", country: "Canada", lat: 49.28, lon: -123.12, kinds: ["origin"] },
  { id: "mex", name: "Mexico City", country: "Mexico", lat: 19.43, lon: -99.13, kinds: ["origin"] },
  { id: "bog", name: "Bogotá", country: "Colombia", lat: 4.71, lon: -74.07, kinds: ["origin"] },
  { id: "lim", name: "Lima", country: "Peru", lat: -12.05, lon: -77.04, kinds: ["origin"] },
  { id: "san", name: "Santiago", country: "Chile", lat: -33.45, lon: -70.65, kinds: ["origin"] },
  { id: "bue", name: "Buenos Aires", country: "Argentina", lat: -34.6, lon: -58.38, kinds: ["origin"] },
  { id: "dub", name: "Dublin", country: "Ireland", lat: 53.35, lon: -6.26, kinds: ["origin"] },
  { id: "mad", name: "Madrid", country: "Spain", lat: 40.42, lon: -3.7, kinds: ["origin"] },
  { id: "rom", name: "Rome", country: "Italy", lat: 41.9, lon: 12.5, kinds: ["origin"] },
  { id: "ber", name: "Berlin", country: "Germany", lat: 52.52, lon: 13.4, kinds: ["origin"] },
  { id: "war", name: "Warsaw", country: "Poland", lat: 52.23, lon: 21.01, kinds: ["origin"] },
  { id: "ist", name: "Istanbul", country: "Türkiye", lat: 41.01, lon: 28.98, kinds: ["origin"] },
  { id: "tlv", name: "Tel Aviv", country: "Israel", lat: 32.08, lon: 34.78, kinds: ["origin"] },
  { id: "cai", name: "Cairo", country: "Egypt", lat: 30.04, lon: 31.24, kinds: ["origin"] },
  { id: "lag", name: "Lagos", country: "Nigeria", lat: 6.52, lon: 3.38, kinds: ["origin"] },
  { id: "nai", name: "Nairobi", country: "Kenya", lat: -1.29, lon: 36.82, kinds: ["origin"] },
  { id: "del", name: "Delhi", country: "India", lat: 28.61, lon: 77.21, kinds: ["origin"] },
  { id: "bkk", name: "Bangkok", country: "Thailand", lat: 13.76, lon: 100.5, kinds: ["origin"] },
  { id: "jkt", name: "Jakarta", country: "Indonesia", lat: -6.21, lon: 106.85, kinds: ["origin"] },
  { id: "sha", name: "Shanghai", country: "China", lat: 31.23, lon: 121.47, kinds: ["origin"] },
  { id: "seo", name: "Seoul", country: "South Korea", lat: 37.57, lon: 126.98, kinds: ["origin"] },
  { id: "akl", name: "Auckland", country: "New Zealand", lat: -36.85, lon: 174.76, kinds: ["origin"] },
  { id: "per", name: "Perth", country: "Australia", lat: -31.95, lon: 115.86, kinds: ["origin"] },
];

export const CITY_BY_ID: ReadonlyMap<string, City> = new Map(CITIES.map((city) => [city.id, city]));

// Backbone edges between hub cities. `kind` records whether the corridor is a
// terrestrial or submarine (undersea) cable so Stage 5 ("Undersea cable")
// only appears in the story when a route genuinely crosses open ocean.
export const HUB_EDGES: readonly HubEdge[] = [
  { a: "nyc", b: "lon", kind: "submarine" },
  { a: "nyc", b: "mia", kind: "terrestrial" },
  { a: "nyc", b: "lax", kind: "terrestrial" },
  { a: "mia", b: "sao", kind: "submarine" },
  { a: "mia", b: "pty", kind: "submarine" },
  { a: "pty", b: "sao", kind: "submarine" },
  { a: "lax", b: "tyo", kind: "submarine" },
  { a: "lax", b: "syd", kind: "submarine" },
  { a: "lax", b: "pty", kind: "submarine" },
  { a: "lon", b: "ams", kind: "terrestrial" },
  { a: "lon", b: "par", kind: "submarine" },
  { a: "ams", b: "fra", kind: "terrestrial" },
  { a: "par", b: "mrs", kind: "terrestrial" },
  { a: "par", b: "fra", kind: "terrestrial" },
  { a: "mrs", b: "dxb", kind: "submarine" },
  { a: "dxb", b: "mum", kind: "submarine" },
  { a: "mum", b: "sin", kind: "submarine" },
  { a: "sin", b: "hkg", kind: "submarine" },
  { a: "hkg", b: "tyo", kind: "submarine" },
  { a: "sin", b: "syd", kind: "submarine" },
  { a: "cpt", b: "mum", kind: "submarine" },
  { a: "cpt", b: "lon", kind: "submarine" },
];

// Approximate, illustrative Starlink gateway locations -- not exact
// coordinates, just a plausible one per served region so every continent has
// somewhere for a Starlink route to come down to earth.
export const GROUND_STATIONS: readonly GroundStation[] = [
  { id: "gs-lax", name: "US West Gateway", country: "United States", lat: 36.5, lon: -119.8, nearestHub: "lax" },
  { id: "gs-nyc", name: "US East Gateway", country: "United States", lat: 39.9, lon: -77.5, nearestHub: "nyc" },
  { id: "gs-sao", name: "Brazil Gateway", country: "Brazil", lat: -22.9, lon: -47.1, nearestHub: "sao" },
  { id: "gs-pty", name: "Andes Gateway", country: "Chile", lat: -33.0, lon: -71.5, nearestHub: "pty" },
  { id: "gs-lon", name: "UK Gateway", country: "United Kingdom", lat: 52.2, lon: -1.0, nearestHub: "lon" },
  { id: "gs-fra", name: "Central Europe Gateway", country: "Germany", lat: 51.0, lon: 9.5, nearestHub: "fra" },
  { id: "gs-cpt", name: "Southern Africa Gateway", country: "South Africa", lat: -29.5, lon: 24.0, nearestHub: "cpt" },
  { id: "gs-lag", name: "West Africa Gateway", country: "Nigeria", lat: 9.0, lon: 7.4, nearestHub: "cpt" },
  { id: "gs-mum", name: "South Asia Gateway", country: "India", lat: 17.4, lon: 78.5, nearestHub: "mum" },
  { id: "gs-sin", name: "Southeast Asia Gateway", country: "Philippines", lat: 14.6, lon: 121.0, nearestHub: "sin" },
  { id: "gs-tyo", name: "Japan Gateway", country: "Japan", lat: 36.2, lon: 138.2, nearestHub: "tyo" },
  { id: "gs-syd", name: "Australia Gateway", country: "Australia", lat: -34.9, lon: 148.7, nearestHub: "syd" },
  { id: "gs-akl", name: "New Zealand Gateway", country: "New Zealand", lat: -40.4, lon: 175.6, nearestHub: "syd" },
];

export function citiesWithKind(kind: City["kinds"][number]): City[] {
  return CITIES.filter((city) => city.kinds.includes(kind));
}
