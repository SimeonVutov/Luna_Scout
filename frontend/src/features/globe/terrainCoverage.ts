/**
 * Footprints of NASA's 5 m LOLA elevation grids, in south-polar stereographic metres
 * (west, south, east, north). Everything inside 80°S has 80 m data and the rest to 60°S has 240 m.
 */
export const footprints5m = [
  { name: "Connecting Ridge", bounds: [-19000, -20000, -3000, -4000] },
  { name: "Shackleton Rim", bounds: [-9000, -15000, 7000, 1000] },
  { name: "Nobile Rim 1", bounds: [74000, 100000, 94000, 120000] },
  { name: "Peak near Shackleton", bounds: [22000, -28000, 38000, -12000] },
  { name: "de Gerlache Rim 1", bounds: [-45000, 7000, -29000, 23000] },
  { name: "Leibnitz Beta Plateau", bounds: [65000, 110000, 81000, 126000] },
  { name: "Malapert Massif", bounds: [-11000, 111000, 10000, 132000] },
  { name: "Haworth", bounds: [-52900, 75600, -23100, 105400] },
  { name: "Shoemaker", bounds: [66000, 29000, 86000, 49000] },
  { name: "Nobile Rim 2", bounds: [147000, 85000, 167000, 105000] },
] as const;

