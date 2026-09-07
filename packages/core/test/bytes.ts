/** Encode a string to UTF-8 bytes without depending on ambient globals. */
export const utf8 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((char) => char.charCodeAt(0)))
