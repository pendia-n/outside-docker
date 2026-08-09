const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type EncryptedJson = {
  ciphertext: string
  nonce: string
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] as number)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function digest(input: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  return digest((typeof input === 'string' ? encoder.encode(input) : input) as BufferSource)
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = await sha256Bytes(input)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function generateChainSecret(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export function generateSalt(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

export async function deriveChainKey(chainSecret: string, chainSalt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(chainSecret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(chainSalt), info: encoder.encode('outside-docker/chain-key/v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJson(key: CryptoKey, value: unknown, associatedData: string): Promise<EncryptedJson> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: encoder.encode(associatedData) as BufferSource },
    key,
    encoder.encode(JSON.stringify(value)) as BufferSource,
  )
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), nonce: bytesToBase64Url(nonce) }
}

export async function decryptJson<T>(key: CryptoKey, encrypted: EncryptedJson, associatedData: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(encrypted.nonce) as BufferSource, additionalData: encoder.encode(associatedData) as BufferSource },
    key,
    base64UrlToBytes(encrypted.ciphertext) as unknown as BufferSource,
  )
  return JSON.parse(decoder.decode(plaintext)) as T
}

export { base64UrlToBytes, bytesToBase64Url }
