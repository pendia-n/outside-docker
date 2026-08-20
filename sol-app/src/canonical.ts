/**
 * A deliberately small JSON Canonicalization Scheme implementation.
 *
 * It follows RFC 8785's important invariants for Phase 1: ECMAScript number
 * rendering, UTF-16 property ordering, no insignificant whitespace, and hard
 * failure for values that JSON cannot represent faithfully.  It also rejects
 * lone UTF-16 surrogates instead of producing a non-interoperable digest.
 */

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

const utf8 = new TextEncoder()

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError(`Unpaired high surrogate at ${path}`)
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalizationError(`Unpaired low surrogate at ${path}`)
    }
  }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`Non-finite number at ${path}`)
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'string':
      assertUnicodeScalarString(value, path)
      return JSON.stringify(value)
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`Unsupported ${typeof value} at ${path}`)
    case 'object':
      break
    default:
      throw new CanonicalizationError(`Unsupported value at ${path}`)
  }

  const object = value as object
  if (ancestors.has(object)) throw new CanonicalizationError(`Circular value at ${path}`)
  ancestors.add(object)

  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new CanonicalizationError(`Sparse array item at ${path}[${index}]`)
        }
        items.push(serialize(value[index], `${path}[${index}]`, ancestors))
      }
      return `[${items.join(',')}]`
    }

    if (!isPlainRecord(object)) throw new CanonicalizationError(`Non-JSON object at ${path}`)
    const members: string[] = []
    for (const key of Object.keys(object).sort()) {
      assertUnicodeScalarString(key, `${path} property name`)
      members.push(`${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`, ancestors)}`)
    }
    return `{${members.join(',')}}`
  } finally {
    ancestors.delete(object)
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, '$', new Set<object>())
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8.encode(canonicalize(value))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Bytes(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? utf8.encode(value) : value
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export async function canonicalSha256(value: unknown): Promise<string> {
  return sha256Bytes(canonicalBytes(value))
}

export function parseCanonicalJson(text: string): CanonicalJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CanonicalizationError(`Invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}`)
  }
  // Running the serializer is also the structural validation pass. Requiring
  // byte-for-byte equality prevents alternate whitespace, duplicate-key, and
  // escape spellings from masquerading as the exact signed representation.
  if (canonicalize(parsed) !== text) throw new CanonicalizationError('JSON is not in canonical form')
  return parsed as CanonicalJson
}
