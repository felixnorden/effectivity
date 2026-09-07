/**
 * Deterministic slugification for catalog derived metadata (D6). Kept minimal
 * and pure: lowercase, separator runs of whitespace/dots/underscores become a
 * single dash, any remaining non-alphanumeric characters are dropped (unicode
 * letters and digits survive), and leading/trailing dashes are trimmed.
 */
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[\s._]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
