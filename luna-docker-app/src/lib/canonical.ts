import canonicalize from 'canonicalize'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function validateJson(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`finite number required at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new TypeError(`unsupported undefined at ${path}.${key}`)
      validateJson(item, `${path}.${key}`)
    }
    return
  }
  throw new TypeError(`unsupported ${typeof value} at ${path}`)
}

export function canonicalJson(value: unknown): string {
  validateJson(value)
  const serialized = canonicalize(value)
  if (serialized === undefined) throw new TypeError('value cannot be canonicalized')
  return serialized
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
