import { describe, expect, it } from 'vitest'
import {
  decryptJson,
  deriveChainKey,
  encryptJson,
  generateChainSecret,
  sha256Hex,
} from '../src/lib/crypto'

describe('cryptographic primitives', () => {
  it('matches the SHA-256 known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('derives a stable per-chain key from secret and salt', async () => {
    const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const first = await deriveChainKey(secret, 'chain-salt-a')
    const same = await deriveChainKey(secret, 'chain-salt-a')
    const different = await deriveChainKey(secret, 'chain-salt-b')
    const encrypted = await encryptJson(first, { stable: true }, 'aad')
    await expect(decryptJson(same, encrypted, 'aad')).resolves.toEqual({ stable: true })
    await expect(decryptJson(different, encrypted, 'aad')).rejects.toThrow()
  })

  it('generates a 256-bit base64url chain secret', () => {
    const secret = generateChainSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('encrypts and decrypts JSON with authenticated associated data', async () => {
    const key = await deriveChainKey(generateChainSecret(), 'salt')
    const encrypted = await encryptJson(key, { proof: 'abc', value: 42 }, 'tenant/chain/1')
    expect(encrypted.ciphertext).not.toContain('abc')
    await expect(decryptJson(key, encrypted, 'tenant/chain/1')).resolves.toEqual({ proof: 'abc', value: 42 })
    await expect(decryptJson(key, encrypted, 'tampered-aad')).rejects.toThrow()
  })

  it('rejects ciphertext tampering', async () => {
    const key = await deriveChainKey(generateChainSecret(), 'salt')
    const encrypted = await encryptJson(key, { safe: true }, 'aad')
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -1)}A` }
    await expect(decryptJson(key, tampered, 'aad')).rejects.toThrow()
  })
})
