import type { SiteSpec } from "../../api/types";

export const maximumSiteRadius = 500;

type Group = { title: string; sites: SiteSpec[] };

const site = (name: string, latitude_deg: number, longitude_deg: number): SiteSpec => ({ name, latitude_deg, longitude_deg, radius_m: 500 });

// Centres from NASA's Lunar Surface Data Book, ACD-50044 Rev A, Table A2-2 (east-positive longitude).
// https://ntrs.nasa.gov/citations/20230007818
export const referenceGroups: Group[] = [
  {
    title: "Artemis III candidate regions",
    sites: [
      site("Malapert Massif", -85.9948, -0.2358),
      site("Haworth", -86.7639, -22.777),
      site("Nobile Rim 1", -85.4381, 37.3667),
      site("Nobile Rim 2", -83.954, 58.8221),
      site("de Gerlache Rim 2", -88.23, -64.6284),
    ],
  },
  {
    title: "Other NASA candidate sites",
    sites: [
      site("Shackleton Rim", -89.7668, -171.87),
      site("Connecting Ridge", -89.4632, -137.49),
      site("Connecting Ridge Extension", -89.0324, -101.999),
      site("Peak near Shackleton", -88.811, 123.6901),
      site("de Gerlache Rim 1", -88.6834, -67.9321),
      site("de Gerlache–Kocher Massif", -85.8296, -116.322),
      site("Faustini Rim A", -87.8897, 90),
      site("Leibnitz Beta Plateau", -85.4266, 31.7428),
      site("Amundsen Rim", -84.2287, 69.444),
    ],
  },
  {
    title: "Missions",
    sites: [site("IM-2 Athena target (Mons Mouton)", -84.78, 29.13)],
  },
];

export const referenceSites: SiteSpec[] = referenceGroups.flatMap((group) => group.sites);

export function coordinatesLabel(latitude: number, longitude: number) {
  return `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? "W" : "E"}`;
}
