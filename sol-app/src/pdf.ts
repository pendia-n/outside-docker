import type { PortableProofV1, PortableVerificationResult } from './verifier'

const encoder = new TextEncoder()

export interface ProofPdfOptions {
  title?: string
  generatedAt?: Date
  verification?: PortableVerificationResult | null
}

function printable(value: unknown): string {
  return String(value ?? '—')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '?')
}

function wrap(label: string, value: unknown, width = 92): string[] {
  const text = `${label}: ${printable(value)}`
  const lines: string[] = []
  let remaining = text
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(' ', width)
    if (split < Math.floor(width / 2)) split = width
    lines.push(remaining.slice(0, split))
    remaining = remaining.slice(split).trimStart()
  }
  lines.push(remaining)
  return lines
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function proofLines(proof: PortableProofV1, options: ProofPdfOptions): string[] {
  const lines: string[] = [
    printable(options.title ?? 'Outdock Portable Proof'),
    '',
    ...wrap('Artifact version', `${proof.format}/${proof.version}`),
    ...wrap('Environment', proof.environment.toUpperCase()),
    ...wrap('Generated at', (options.generatedAt ?? new Date()).toISOString()),
    '',
    'EVENT',
    ...wrap('Event ID', proof.event.id),
    ...wrap('Track / type', `${proof.event.track} / ${proof.event.event_type}`),
    ...wrap('External reference', proof.event.external_ref),
    ...wrap('Chain ID', proof.event.chain_id),
    ...wrap('Position', proof.event.position),
    ...wrap('Occurred at (claimed)', proof.event.occurred_at),
    ...wrap('Received at (OD)', proof.event.received_at),
    ...wrap('Commitment', proof.event.commitment),
    ...wrap('Manifest hash', proof.event.manifest_hash),
    ...wrap('Previous proof', proof.event.previous_proof),
    ...wrap('Event proof', proof.event.proof),
    '',
    'SIGNED RECEIPT',
    ...wrap('Signing key', proof.receipt.signing_key_id),
    ...wrap('Algorithm', proof.receipt.signature_algorithm),
    ...wrap('Signature', proof.receipt.signature),
    '',
    'ANCHOR',
    ...wrap('Status', proof.event.anchor_status),
  ]
  if (proof.anchor) {
    lines.push(
      ...wrap('Batch reference', proof.anchor.batch_ref),
      ...wrap('Merkle root', proof.anchor.merkle_root),
      ...wrap('Anchor manifest hash', proof.anchor.manifest_hash),
      ...wrap('Leaf index', proof.anchor.leaf_index),
      ...wrap('Base network / chain', `${proof.anchor.network ?? 'Base'} / ${proof.anchor.chain_id}`),
      ...wrap('Contract', proof.anchor.contract_address),
      ...wrap('Transaction', proof.anchor.transaction_hash),
      ...wrap('Block', proof.anchor.block_number),
      ...wrap('Confirmed at', proof.anchor.confirmed_at),
    )
  } else {
    lines.push('No confirmed Base anchor is attached to this artifact.')
  }
  if (options.verification) {
    lines.push(
      '',
      'LOCAL VERIFICATION',
      ...wrap('Overall', options.verification.valid ? 'VALID' : 'FAILED'),
      ...wrap('Receipt signature', options.verification.receipt_signature ? 'valid' : 'invalid'),
      ...wrap('Event-chain proof', options.verification.event_chain_proof ? 'valid' : 'invalid'),
      ...wrap('Merkle inclusion', options.verification.merkle_inclusion == null ? 'not anchored' : options.verification.merkle_inclusion ? 'valid' : 'invalid'),
      ...wrap('Base anchor', options.verification.polygon_anchor == null ? 'not checked' : options.verification.polygon_anchor ? 'valid' : 'invalid'),
      ...wrap('Failures', options.verification.failures.join(', ') || 'none'),
    )
  }
  lines.push('', ...wrap('Important', proof.disclaimer))
  return lines
}

/** Creates an in-memory PDF; no original document or generated PDF is persisted. */
export function createProofPdf(proof: PortableProofV1, options: ProofPdfOptions = {}): Uint8Array {
  const lines = proofLines(proof, options)
  const pages: string[][] = []
  for (let index = 0; index < lines.length; index += 52) pages.push(lines.slice(index, index + 52))
  if (pages.length === 0) pages.push(['Outdock Portable Proof'])

  const pageObjectIds = pages.map((_, index) => 3 + index * 2)
  const contentObjectIds = pages.map((_, index) => 4 + index * 2)
  const fontObjectId = 3 + pages.length * 2
  const objects = new Map<number, string>()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`)
  pages.forEach((pageLines, index) => {
    const pageId = pageObjectIds[index]
    const contentId = contentObjectIds[index]
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    const operations = [
      'BT',
      '/F1 9 Tf',
      '46 752 Td',
      '12 TL',
      ...pageLines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n')
    objects.set(contentId, `<< /Length ${encoder.encode(operations).length} >>\nstream\n${operations}\nendstream`)
  })
  objects.set(fontObjectId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  let document = '%PDF-1.4\n%OD-PROOF\n'
  const offsets: number[] = [0]
  for (let id = 1; id <= fontObjectId; id += 1) {
    offsets[id] = encoder.encode(document).length
    document += `${id} 0 obj\n${objects.get(id)}\nendobj\n`
  }
  const xrefOffset = encoder.encode(document).length
  document += `xref\n0 ${fontObjectId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= fontObjectId; id += 1) document += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  document += `trailer\n<< /Size ${fontObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return encoder.encode(document)
}

export function createProofPdfResponse(proof: PortableProofV1, options: ProofPdfOptions = {}): Response {
  const safeEventId = proof.event.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  return new Response(createProofPdf(proof, options), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${safeEventId}.odproof.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
