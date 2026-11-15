/** Slope classes shared by the map overlay and its legend. One violet ramp, darker means steeper. */
export const slopeClasses = [
  { label: "≤ 5°", upTo: 5, color: [214, 196, 247] },
  { label: "5–10°", upTo: 10, color: [167, 128, 232] },
  { label: "10–15°", upTo: 15, color: [122, 79, 208] },
  { label: "> 15°", upTo: Infinity, color: [76, 36, 150] },
] as const;

export function slopeClass(degrees: number) {
  return slopeClasses.find((entry) => degrees <= entry.upTo) ?? slopeClasses[slopeClasses.length - 1];
}

export function slopeColor(index: number) {
  return `rgb(${slopeClasses[index].color.join(" ")})`;
}
