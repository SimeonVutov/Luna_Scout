/** A message fit to show a user for anything that was thrown. */
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
