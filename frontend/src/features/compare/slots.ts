/** The two compared sites. Colours were validated for colour-blind separation on the dark surface. */
export const slots = ["a", "b"] as const;
export type Slot = (typeof slots)[number];

export const slotColor: Record<Slot, string> = { a: "#3987e5", b: "#d55181" };
export const slotLabel: Record<Slot, string> = { a: "A", b: "B" };
