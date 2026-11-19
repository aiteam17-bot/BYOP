/**
 * Only http(s) links are allowed. Members can write to the database directly,
 * so pages re-check this before rendering any stored link: a `javascript:` link
 * would run code when clicked.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
