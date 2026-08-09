const encoder = new TextEncoder()

/**
 * Deterministic length-prefix framing for hash inputs.
 * Each field is encoded as `<UTF-8 byte length>:<UTF-8 bytes>`.
 */
export function frame(parts: readonly string[]): Uint8Array {
  const bytes: number[] = []
  for (const part of parts) {
    const encoded = encoder.encode(part)
    const prefix = encoder.encode(`${encoded.byteLength}:`)
    for (let index = 0; index < prefix.length; index += 1) bytes.push(prefix[index] as number)
    for (let index = 0; index < encoded.length; index += 1) bytes.push(encoded[index] as number)
  }
  return Uint8Array.from(bytes)
}
