/**
 * Byte helpers without depending on ambient globals (TextDecoder is untyped
 * under the repository's `types: []` tsconfig).
 */

/** Encode a UTF-8 string to bytes. */
export const encodeUtf8 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((char) => char.codePointAt(0) ?? 0))

/** Decode UTF-8 bytes to a string. */
export const decodeUtf8 = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0
    if (b0 < 0x80) {
      out += String.fromCodePoint(b0)
      i += 1
    } else if (b0 < 0xe0) {
      out += String.fromCodePoint(((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f))
      i += 2
    } else if (b0 < 0xf0) {
      out += String.fromCodePoint(
        ((b0 & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f),
      )
      i += 3
    } else {
      const codepoint =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f)
      out += String.fromCodePoint(codepoint)
      i += 4
    }
  }
  return out
}
