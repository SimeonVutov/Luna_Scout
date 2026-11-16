const storageKey = "lunascout.session.v1";

let fallback: string | null = null;

/**
 * A random ID this browser keeps for itself. It tells the server which browser started a
 * simulation, so on a public server only that browser can pause or cancel it. It identifies
 * nothing else and is never shown.
 */
export function browserSession(): string {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) return saved;

    const created = crypto.randomUUID();
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    // Without browser storage the ID lasts as long as the page.
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}
