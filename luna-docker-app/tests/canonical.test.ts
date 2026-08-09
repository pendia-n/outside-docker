import { describe, expect, it } from 'vitest'
import { canonicalJson, canonicalBytes } from '../src/lib/canonical'
import { frame } from '../src/lib/bytes'

describe('canonical JSON', () => {
  it('normalizes object key order without changing arrays', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [3, 2, 1] }))
      .toBe('{"a":{"x":3,"y":2},"list":[3,2,1],"z":1}')
  })

  it('encodes Unicode and numbers deterministically', () => {
    expect(canonicalJson({ label: '證據 🌍', value: 1.5 })).toBe('{"label":"證據 🌍","value":1.5}')
    expect(new TextDecoder().decode(canonicalBytes({ ok: true }))).toBe('{"ok":true}')
  })

  it('rejects unsupported values rather than silently changing the proof input', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/unsupported|undefined/i)
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite|number/i)
  })
})

describe('length-prefixed framing', () => {
  it('prevents ambiguous concatenation', () => {
    const first = frame(['ab', 'c'])
    const second = frame(['a', 'bc'])
    expect(first).not.toEqual(second)
    expect(new TextDecoder().decode(first)).toBe('2:ab1:c')
  })
})
