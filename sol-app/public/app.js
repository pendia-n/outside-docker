(() => {
  'use strict'

  const page = document.querySelector('[data-page]')?.dataset.page
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let csrfToken = ''

  const PROOF_MAX_BYTES = 8 * 1024 * 1024
  const LOCAL_EVIDENCE_MAX_BYTES = 128 * 1024 * 1024
  const JSON_MAX_DEPTH = 32
  const JSON_MAX_NODES = 50_000
  const JSON_MAX_COLLECTION_ITEMS = 20_000

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message)
      this.status = status
      this.payload = payload
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {})
    if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    const method = String(options.method || 'GET').toUpperCase()
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrfToken)
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers })
    const type = response.headers.get('content-type') || ''
    const payload = type.includes('application/json') ? await response.json() : await response.text()
    if (!response.ok) {
      const message = typeof payload === 'object' ? payload.error || payload.detail : payload
      throw new ApiError(message || `Request failed (${response.status})`, response.status, payload)
    }
    return payload
  }

  function formObject(form) {
    const data = new FormData(form)
    const object = Object.fromEntries(data.entries())
    for (const checkbox of $$('input[type=checkbox]', form)) {
      if (checkbox.name === 'scopes') continue
      object[checkbox.name] = checkbox.checked
    }
    const scopes = data.getAll('scopes')
    if (scopes.length) object.scopes = scopes
    return object
  }

  function setResult(element, message, kind = '') {
    if (!element) return
    element.className = `form-result${kind ? ` ${kind}` : ''}`
    element.textContent = message
  }

  function setBusy(form, busy) {
    for (const control of $$('button,input,select,textarea', form)) control.disabled = busy
    const button = $('button[type=submit],button:not([type])', form)
    if (button) {
      if (busy) {
        button.dataset.label = button.textContent
        button.textContent = 'Working…'
      } else if (button.dataset.label) {
        button.textContent = button.dataset.label
        delete button.dataset.label
      }
    }
  }

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }

  function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing or invalid`)
    return value
  }

  function assertExactKeys(value, expected, label) {
    const actual = Object.keys(record(value, label)).sort()
    const wanted = [...expected].sort()
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      throw new Error(`${label} has unsupported fields`)
    }
  }

  function assertJsonBounds(root) {
    const pending = [{ value: root, depth: 0 }]
    let nodes = 0
    while (pending.length) {
      const { value, depth } = pending.pop()
      nodes += 1
      if (nodes > JSON_MAX_NODES) throw new Error('Proof package is too complex')
      if (depth > JSON_MAX_DEPTH) throw new Error('Proof package is nested too deeply')
      if (typeof value === 'string' && value.length > PROOF_MAX_BYTES) throw new Error('Proof package contains an oversized value')
      if (!value || typeof value !== 'object') continue
      const children = Array.isArray(value) ? value : Object.values(value)
      if (children.length > JSON_MAX_COLLECTION_ITEMS) throw new Error('Proof package contains too many items')
      for (const child of children) pending.push({ value: child, depth: depth + 1 })
    }
  }

  function assertFileBound(file, maximum, label) {
    if (!file || !Number.isFinite(file.size) || file.size < 0 || file.size > maximum) {
      throw new Error(`${label} must be no larger than ${Math.floor(maximum / 1024 / 1024)} MB`)
    }
  }

  async function readProofPackage(file) {
    assertFileBound(file, PROOF_MAX_BYTES, 'Proof package')
    const text = await file.text()
    if (encoder.encode(text).byteLength > PROOF_MAX_BYTES) throw new Error('Proof package is too large')
    let parsed
    try { parsed = JSON.parse(text) }
    catch { throw new Error('Proof package is not valid JSON') }
    assertJsonBounds(parsed)
    return record(parsed, 'Proof package')
  }

  function hex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  function fromHex(value) {
    if (!/^[a-f0-9]*$/i.test(value) || value.length % 2) throw new Error('Invalid hexadecimal data')
    return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
  }

  function b64url(bytes) {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  }

  function unb64url(value, maximumBytes = PROOF_MAX_BYTES, label = 'base64url value') {
    if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximumBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      throw new Error(`${label} is invalid`)
    }
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
    let decoded
    try { decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)) }
    catch { throw new Error(`${label} is invalid`) }
    if (decoded.byteLength > maximumBytes || b64url(decoded) !== value) throw new Error(`${label} is invalid`)
    return decoded
  }

  async function sha256(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
  }

  async function contentCommitment(contentHash, recordSalt) {
    const prefix = encoder.encode('OD1|CONTENT|')
    const salt = fromHex(recordSalt)
    const hash = fromHex(contentHash)
    if (salt.byteLength !== 32 || hash.byteLength !== 32) throw new Error('Content hash and record salt must be 32 bytes')
    const input = new Uint8Array(prefix.byteLength + salt.byteLength + hash.byteLength)
    input.set(prefix)
    input.set(salt, prefix.byteLength)
    input.set(hash, prefix.byteLength + salt.byteLength)
    return sha256(input)
  }

  function randomHex(length) {
    return hex(crypto.getRandomValues(new Uint8Array(length)))
  }

  async function encryptCapsule(value, passcode, recordId) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const aad = encoder.encode(`OD1|CAPSULE|1|${recordId}`)
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(canonical(value))))
    return { version: '1', kdf: 'PBKDF2-HMAC-SHA-256', iterations: 310000, salt: b64url(salt), cipher: 'AES-256-GCM', iv: b64url(iv), aad: b64url(aad), ciphertext: b64url(ciphertext) }
  }

  async function decryptCapsule(capsule, passcode, recordId) {
    assertExactKeys(capsule, ['version', 'kdf', 'iterations', 'salt', 'cipher', 'iv', 'aad', 'ciphertext'], 'Encrypted capsule')
    if (capsule.version !== '1' || capsule.kdf !== 'PBKDF2-HMAC-SHA-256' || capsule.iterations !== 310000 || capsule.cipher !== 'AES-256-GCM') {
      throw new Error('Encrypted capsule uses unsupported algorithms or parameters')
    }
    if (typeof passcode !== 'string' || passcode.length === 0 || passcode.length > 1024) throw new Error('Passcode is missing or too long')
    if (typeof recordId !== 'string' || recordId.length === 0 || recordId.length > 128) throw new Error('Capsule record identifier is invalid')
    const salt = unb64url(capsule.salt, 16, 'Capsule KDF salt')
    const iv = unb64url(capsule.iv, 12, 'Capsule IV')
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error('Encrypted capsule salt or IV has the wrong length')
    const expectedAad = encoder.encode(`OD1|CAPSULE|1|${recordId}`)
    const suppliedAad = unb64url(capsule.aad, 512, 'Capsule authenticated data')
    if (b64url(suppliedAad) !== b64url(expectedAad)) throw new Error('Encrypted capsule authenticated data does not match the event')
    const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    const ciphertext = unb64url(capsule.ciphertext, PROOF_MAX_BYTES, 'Capsule ciphertext')
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: expectedAad }, key, ciphertext)
    let decoded
    try { decoded = JSON.parse(decoder.decode(plaintext)) }
    catch { throw new Error('Encrypted capsule plaintext is invalid') }
    assertJsonBounds(decoded)
    return record(decoded, 'Encrypted capsule plaintext')
  }

  function downloadJson(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/vnd.outside-docker.proof+json' })
    const url = URL.createObjectURL(blob)
    const link = Object.assign(document.createElement('a'), { href: url, download: name })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
  }

  function formatTime(value) {
    if (!value) return '—'
    const date = new Date(value)
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
  }

  async function initLanding() {
    const registerPanel = $('#register-card')
    const loginPanel = $('#login-card')
    const tabs = $$('.access-tabs a')
    const register = $('#register')
    const login = $('#login')
    const role = $('[name=role]', register)
    const supplierFields = $('#supplier-fields')
    const verifierFields = $('#verifier-fields')

    const showAccess = (mode, scroll = true) => {
      const useLogin = mode === 'login'
      registerPanel.style.display = useLogin ? 'none' : 'block'
      loginPanel.style.display = useLogin ? 'block' : 'none'
      tabs.forEach((tab) => tab.classList.toggle('active', useLogin ? tab.hash === '#login-card' : tab.hash === '#register-card'))
      if (scroll) $('#access').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    function updateRoleFields() {
      const supplier = role.value === 'supplier'
      supplierFields.hidden = !supplier
      verifierFields.hidden = supplier
      for (const field of $$('input,select', supplierFields)) field.required = supplier && ['organization', 'address_line1', 'city', 'postal_code', 'country'].includes(field.name)
      $('[name=scope_id]', verifierFields).required = !supplier
    }

    tabs.forEach((tab) => tab.addEventListener('click', (event) => {
      event.preventDefault()
      const mode = tab.hash === '#login-card' ? 'login' : 'register'
      showAccess(mode)
      history.replaceState(null, '', tab.hash)
    }))
    $$('a[href="#login-card"],a[href="#register-card"]').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault()
      const mode = link.hash === '#login-card' ? 'login' : 'register'
      showAccess(mode)
      history.replaceState(null, '', link.hash)
    }))
    role.addEventListener('change', updateRoleFields)
    updateRoleFields()
    if (location.hash === '#login-card') showAccess('login', false)

    let availabilityRequest = 0
    let availabilityTimer
    register.elements.username.addEventListener('input', () => {
      clearTimeout(availabilityTimer)
      const request = ++availabilityRequest
      const username = register.elements.username.value.trim().toLowerCase()
      register.elements.username.value = username
      $('#availability').textContent = ''
      availabilityTimer = setTimeout(async () => {
        try {
          const result = await api(`/api/username/${encodeURIComponent(username)}`)
          if (request !== availabilityRequest) return
          $('#availability').textContent = result.available ? '✓ Available' : result.reason === 'invalid' ? 'Use 3–32 lowercase letters, numbers, _ or -.' : 'Already registered'
        } catch {
          if (request === availabilityRequest) $('#availability').textContent = 'Availability could not be checked.'
        }
      }, 250)
    })

    register.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!register.reportValidity()) return
      setBusy(register, true)
      setResult($('#register-result'), '')
      try {
        const result = await api('/api/register', { method: 'POST', body: JSON.stringify(formObject(register)) })
        if (result.checkout_url) {
          setResult($('#register-result'), 'Opening secure Stripe Checkout…', 'success')
          location.assign(result.checkout_url)
          return
        }
        setResult($('#register-result'), 'Account created. Sign in to open your workspace.', 'success')
        login.elements.username.value = result.username
        await sleep(500)
        showAccess('login')
      } catch (error) {
        setResult($('#register-result'), error.message, 'error')
      } finally {
        setBusy(register, false)
      }
    })

    login.addEventListener('submit', async (event) => {
      event.preventDefault()
      setBusy(login, true)
      try {
        const result = await api('/api/login', { method: 'POST', body: JSON.stringify(formObject(login)) })
        if (result.totp_required) {
          $('#totp-login-field').hidden = false
          $('[name=totp_code]', login).required = true
          setResult($('#login-result'), 'Enter your authenticator or recovery code.', 'error')
          return
        }
        setResult($('#login-result'), 'Signed in. Opening your workspace…', 'success')
        location.assign('/app')
      } catch (error) {
        if (error.payload?.code === 'totp_required') {
          $('#totp-login-field').hidden = false
          $('[name=totp_code]', login).required = true
        }
        setResult($('#login-result'), error.message, 'error')
      } finally {
        setBusy(login, false)
      }
    })
  }

  const appState = { session: null, dashboard: null, cases: [], selectedCase: null, sources: [], scopes: [] }

  function notice(message, kind = 'success') {
    const element = $('#app-notice')
    if (!element) return
    element.hidden = false
    element.className = `app-notice ${kind}`
    element.textContent = message
    clearTimeout(notice.timer)
    notice.timer = setTimeout(() => { element.hidden = true }, 6000)
  }

  function activateView(target) {
    const buttons = $$('.app-nav button')
    const selected = buttons.find((button) => button.dataset.target === target && !button.hidden) || buttons.find((button) => button.dataset.target === 'overview')
    const safeTarget = selected?.dataset.target || 'overview'
    buttons.forEach((button) => button.classList.toggle('active', button.dataset.target === safeTarget))
    $$('.app-view').forEach((view) => view.classList.toggle('active', view.dataset.view === safeTarget))
    history.replaceState(null, '', `#${safeTarget}`)
  }

  async function loadDashboard() {
    const dashboard = await api('/api/dashboard')
    appState.dashboard = dashboard
    $('#metric-cases').textContent = dashboard.counts?.cases ?? 0
    $('#metric-sources').textContent = dashboard.counts?.sources ?? 0
    $('#metric-events').textContent = dashboard.counts?.events ?? 0
    $('#metric-anchors').textContent = dashboard.counts?.anchor_failures ? `${dashboard.counts.anchor_failures} failed` : 'Healthy'
    $('#recent-receipts').innerHTML = renderRecords(dashboard.recent_receipts || [], (receipt) => `<strong>${escapeHtml(receipt.event_type || receipt.action || 'Event')}</strong><span>${formatTime(receipt.received_at)} · ${escapeHtml(receipt.anchor_status)}</span>`)
    $('#account-summary').innerHTML = `<dt>User</dt><dd>${escapeHtml(dashboard.user.username)}</dd><dt>Role</dt><dd>${escapeHtml(dashboard.user.role)}</dd><dt>Mode</dt><dd>${escapeHtml(dashboard.user.supplier_mode || 'Verifier')}</dd><dt>Environment</dt><dd>${escapeHtml(dashboard.environment)}</dd>`
    $('#environment-badge').textContent = dashboard.environment
    renderEntitlements(dashboard.entitlements || [])
  }

  function renderRecords(items, itemRenderer) {
    const records = Array.isArray(items) ? items : []
    return records.length ? records.map((item) => `<article class="record-card">${itemRenderer(item)}</article>`).join('') : '<div class="empty-state">Nothing here yet.</div>'
  }

  function renderEntitlements(items) {
    $('#entitlement-list').innerHTML = renderRecords(items, (item) => `<strong>${escapeHtml(item.kind === 'writer_plan' ? `Plan ${item.plan_code || ''}` : 'Read Pass')}</strong><span>${escapeHtml(item.status)} · until ${formatTime(item.valid_until)}${item.scope_id ? ` · scope ${escapeHtml(item.scope_id)}` : ''}</span>`)
  }

  async function loadCases() {
    const result = await api('/api/h/cases')
    appState.cases = result.cases || []
    $('#case-list').innerHTML = appState.cases.length ? appState.cases.map((item) => `<button class="record-card" data-case-ref="${escapeHtml(item.case_ref)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.case_ref)} · ${item.event_count || 0} events</span></button>`).join('') : '<div class="empty-state">Create the first Track H case.</div>'
    $$('[data-case-ref]').forEach((button) => button.addEventListener('click', () => selectCase(button.dataset.caseRef)))
  }

  async function selectCase(caseRef) {
    const [caseResult, eventResult] = await Promise.all([
      api(`/api/h/cases/${encodeURIComponent(caseRef)}`),
      api(`/api/h/cases/${encodeURIComponent(caseRef)}/events`),
    ])
    const humanCase = caseResult.case || caseResult
    appState.selectedCase = humanCase
    $('#case-title').textContent = `${humanCase.title} · ${humanCase.case_ref}`
    $('#add-event-button').disabled = false
    $$('[data-case-ref]').forEach((button) => button.classList.toggle('active', button.dataset.caseRef === caseRef))
    $('#case-timeline').innerHTML = renderTimeline(eventResult.events || [], true)
    bindProofDownloads($('#case-timeline'))
  }

  function renderTimeline(events, allowDownloads = false) {
    const timeline = Array.isArray(events) ? events : []
    if (!timeline.length) return '<div class="empty-state">This chain has no events yet.</div>'
    return timeline.map((event) => {
      const actions = allowDownloads && event?.id
        ? `<div class="record-actions"><button class="quiet-button" data-download-proof="${escapeHtml(event.id)}">Download proof</button><a class="quiet-button" href="/api/events/${encodeURIComponent(event.id)}/proof.pdf" target="_blank" rel="noopener">PDF</a></div>`
        : ''
      return `<article class="timeline-event"><header><strong>${escapeHtml(event?.event_type || event?.action || 'Event')}</strong><span>#${escapeHtml(event?.position ?? '—')}</span></header><span>${formatTime(event?.occurred_at || event?.received_at)}</span><code>${escapeHtml(event?.proof || 'proof unavailable')}</code><small>${escapeHtml(event?.anchor_status || 'pending_anchor')}</small>${actions}</article>`
    }).join('')
  }

  function bindProofDownloads(root) {
    if (!root) return
    $$('[data-download-proof]', root).forEach((button) => button.addEventListener('click', async () => {
      try {
        const eventId = button.dataset.downloadProof
        const proof = await api(`/api/events/${encodeURIComponent(eventId)}/proof`)
        downloadJson(`${eventId}.odproof`, proof)
      } catch (error) { notice(error.message, 'error') }
    }))
  }

  async function submitHumanEvent(form) {
    if (!appState.selectedCase) throw new Error('Select a case first')
    const file = form.elements.file.files[0]
    const structuredText = form.elements.structured_text.value
    if (!file && !structuredText) throw new Error('Choose a local file or enter a structured note')
    if (file) assertFileBound(file, LOCAL_EVIDENCE_MAX_BYTES, 'Local evidence file')
    const contentBytes = file ? new Uint8Array(await file.arrayBuffer()) : encoder.encode(structuredText)
    const contentHash = await sha256(contentBytes)
    const recordSalt = randomHex(32)
    const commitment = await contentCommitment(contentHash, recordSalt)
    const occurredAt = form.elements.occurred_at.value ? new Date(form.elements.occurred_at.value).toISOString() : new Date().toISOString()
    const manifest = { version: '1', case_id: appState.selectedCase.id, event_type: form.elements.event_type.value.trim(), occurred_at: occurredAt, content_kind: file ? 'file' : 'string', content_length: contentBytes.byteLength, commitment }
    const manifestHash = await sha256(canonical(manifest))
    const idempotencyKey = `h-${crypto.randomUUID()}`
    const correctionId = form.elements.corrects_event_id.value.trim()
    const endpoint = correctionId
      ? `/api/h/cases/${encodeURIComponent(appState.selectedCase.case_ref)}/events/${encodeURIComponent(correctionId)}/corrections`
      : `/api/h/cases/${encodeURIComponent(appState.selectedCase.case_ref)}/events`
    const result = await api(endpoint, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ event_type: manifest.event_type, occurred_at: occurredAt, commitment, manifest_hash: manifestHash }) })
    const capsule = await encryptCapsule({ content_hash: contentHash, record_salt: recordSalt, content_kind: manifest.content_kind, content_name: file?.name || null, content_type: file?.type || 'text/plain', structured_text: file ? null : structuredText }, form.elements.passcode.value, result.event_id)
    const signedReceipt = result.signed_receipt || {
      receipt: result.receipt,
      receipt_json: result.receipt_json,
      signature: result.signature,
      signing_key_id: result.signing_key_id,
      signature_algorithm: result.signature_algorithm,
      public_key_jwk: result.public_key_jwk || null,
    }
    const receiptPayload = record(signedReceipt.receipt, 'Signed receipt payload')
    const proofPackage = {
      format: 'odproof',
      version: 1,
      environment: receiptPayload.environment || appState.dashboard?.environment,
      event: {
        id: result.event_id,
        chain_id: result.chain_id,
        external_ref: receiptPayload.external_ref,
        track: receiptPayload.track,
        event_type: receiptPayload.event_type,
        position: result.position,
        commitment: receiptPayload.commitment,
        manifest_hash: receiptPayload.manifest_hash,
        previous_proof: result.previous_proof,
        proof: result.proof,
        occurred_at: receiptPayload.occurred_at,
        received_at: receiptPayload.received_at,
        anchor_status: result.anchor_status,
      },
      receipt: {
        payload: receiptPayload,
        canonical_json: signedReceipt.receipt_json || canonical(receiptPayload),
        signature: signedReceipt.signature,
        signing_key_id: signedReceipt.signing_key_id || signedReceipt.public_key_id,
        signature_algorithm: signedReceipt.signature_algorithm || signedReceipt.algorithm,
        public_key_jwk: signedReceipt.public_key_jwk || null,
      },
      anchor: result.anchor || null,
      manifest,
      capsule,
      disclaimer: 'Integrity verification shows consistency and ordering; it does not establish substantive truth or legal admissibility.',
    }
    downloadJson(`${appState.selectedCase.case_ref}-${result.position}.odproof`, proofPackage)
    form.reset()
    form.hidden = true
    await Promise.all([selectCase(appState.selectedCase.case_ref), loadDashboard()])
    notice('Event appended and portable proof downloaded.')
  }

  async function loadMachine() {
    const [keys, sources, events, usage] = await Promise.all([
      api('/api/api-keys'),
      api('/api/v1/sources'),
      api('/api/v1/records?limit=50'),
      api('/api/v1/usage'),
    ])
    $('#api-key-list').innerHTML = renderRecords(keys?.keys, (key) => {
      const actions = !key?.revoked_at && key?.is_active
        ? `<div class="record-actions"><button class="quiet-button" data-key-action="rotate" data-key-id="${escapeHtml(key.id)}">Rotate</button><button class="quiet-button danger" data-key-action="revoke" data-key-id="${escapeHtml(key.id)}">Revoke</button></div>`
        : ''
      return `<strong>${escapeHtml(key?.label || 'Unnamed key')}</strong><span>${escapeHtml(Array.isArray(key?.scopes) ? key.scopes.join(', ') : '')} · ${key?.revoked_at ? 'revoked' : 'active'}</span>${actions}`
    })
    $$('[data-key-action]', $('#api-key-list')).forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.keyAction
      if (!confirm(action === 'rotate' ? 'Rotate this key? The current key will stop working immediately.' : 'Revoke this key? This cannot be undone.')) return
      try {
        const endpoint = `/api/api-keys/${encodeURIComponent(button.dataset.keyId)}${action === 'rotate' ? '/rotate' : ''}`
        const result = await api(endpoint, { method: action === 'rotate' ? 'POST' : 'DELETE' })
        if (action === 'rotate') {
          $('#api-key-result').hidden = false
          $('#api-key-result').textContent = `Copy now — this replacement key is shown once: ${result.api_key}`
        }
        await loadMachine()
        notice(action === 'rotate' ? 'API key rotated.' : 'API key revoked.')
      } catch (error) { notice(error.message, 'error') }
    }))
    appState.sources = Array.isArray(sources?.sources) ? sources.sources : []
    $('#source-list').innerHTML = renderRecords(appState.sources, (source) => `<strong>${escapeHtml(source.label)}</strong><span>${escapeHtml(source.external_ref)} · ${escapeHtml(source.out_of_order_policy)}</span>`)
    $('#machine-events').innerHTML = renderTimeline(events?.records, true)
    bindProofDownloads($('#machine-events'))
    $('#machine-usage').textContent = `${usage.records_observed ?? 0} records observed · ${usage.writes_current_minute ?? 0}/${usage.writes_per_minute ?? '—'} writes this minute · up to ${usage.records_per_write ?? '—'} records/write`
  }

  async function loadVerifier() {
    const result = await api('/api/verifier/scopes')
    appState.scopes = Array.isArray(result?.scopes) ? result.scopes : []
    $('#verifier-scope-list').innerHTML = appState.scopes.length ? appState.scopes.map((scope) => `<button class="record-card" data-verifier-scope="${escapeHtml(scope.id)}"><strong>${escapeHtml(scope.title)}</strong><span>${escapeHtml(scope.scope_type)} · access until ${formatTime(scope.valid_until)}</span></button>`).join('') : '<div class="empty-state">No active paid scopes.</div>'
    $$('[data-verifier-scope]').forEach((button) => button.addEventListener('click', async () => {
      const detail = await api(`/api/verifier/scopes/${encodeURIComponent(button.dataset.verifierScope)}`)
      const scope = detail?.scope || detail
      $('#verifier-scope-title').textContent = scope?.title || 'Evidence scope'
      $('#verifier-scope-detail').innerHTML = renderTimeline(detail?.events)
    }))
  }

  async function loadShares() {
    const result = await api('/api/shares')
    const writableScopes = Array.isArray(result?.available_scopes) ? result.available_scopes : []
    $('#share-scope-select').innerHTML = writableScopes.map((scope) => `<option value="${escapeHtml(scope.id)}">${escapeHtml(scope.title)}</option>`).join('')
    $('#share-list').innerHTML = renderRecords(result?.shares, (share) => `<strong>${escapeHtml(share.scope_title || share.scope_id)}</strong><span>${share.revoked_at ? 'revoked' : `expires ${formatTime(share.expires_at)}`}</span>`)
  }

  async function verifySignedReceipt(signedReceipt, expectedEnvironment) {
    const signed = record(signedReceipt, 'Signed receipt')
    const receipt = record(signed.receipt, 'Receipt payload')
    const keyId = signed.signing_key_id || signed.public_key_id
    if (typeof keyId !== 'string' || !keyId || keyId.length > 128) throw new Error('Receipt signing key ID is missing or invalid')
    if (receipt.signing_key_id !== keyId) throw new Error('Receipt signing key ID does not match its payload')
    const algorithm = signed.signature_algorithm || signed.algorithm
    if (algorithm !== 'Ed25519' || receipt.signature_algorithm !== 'Ed25519') throw new Error('Only Ed25519 receipt signatures are supported')

    // The artifact's embedded JWK is deliberately ignored. The key ID must resolve
    // through OD's server-side registry so a self-signed package cannot trust itself.
    const keyResponse = record(await api(`/api/receipt-public-key?key_id=${encodeURIComponent(keyId)}`), 'Receipt public key response')
    const publicKey = keyResponse.public_key_jwk || keyResponse.jwk
    if (!publicKey || typeof publicKey !== 'object') throw new Error('The registered receipt public key is unavailable')
    if (keyResponse.key_id && keyResponse.key_id !== keyId) throw new Error('The receipt key registry returned a different key')
    if (keyResponse.algorithm !== 'Ed25519') throw new Error('The receipt key registry returned an unsupported algorithm')
    if (expectedEnvironment && keyResponse.environment && keyResponse.environment !== expectedEnvironment) throw new Error('Receipt key environment does not match the proof')

    const canonicalReceipt = canonical(receipt)
    if (signed.receipt_json !== undefined && signed.receipt_json !== canonicalReceipt) throw new Error('Receipt payload does not match its canonical signed JSON')
    const signature = unb64url(signed.signature, 64, 'Receipt signature')
    if (signature.byteLength !== 64) throw new Error('Receipt signature has the wrong length')
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'Ed25519' }, false, ['verify'])
    return crypto.subtle.verify('Ed25519', key, signature, encoder.encode(canonicalReceipt))
  }

  function eventMatchesReceipt(event, receipt, environment) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false
    return event.id === receipt.event_id
      && event.chain_id === receipt.chain_id
      && event.external_ref === receipt.external_ref
      && event.track === receipt.track
      && event.event_type === receipt.event_type
      && event.position === receipt.position
      && event.commitment === receipt.commitment
      && event.manifest_hash === receipt.manifest_hash
      && event.previous_proof === receipt.previous_proof
      && event.proof === receipt.proof
      && event.occurred_at === receipt.occurred_at
      && event.received_at === receipt.received_at
      && receipt.anchor_status === 'pending_anchor'
      && receipt.environment === environment
  }

  function serverProofFrom(proofPackage) {
    return {
      format: proofPackage.format,
      version: proofPackage.version,
      environment: proofPackage.environment,
      event: proofPackage.event,
      receipt: proofPackage.receipt,
      anchor: proofPackage.anchor ?? null,
      disclaimer: proofPackage.disclaimer || 'Integrity verification is not a truth determination.',
    }
  }

  async function verifyOnServer(proofPackage) {
    const normalize = (response) => {
      const result = record(response?.verification || response, 'Server verification response')
      return {
        valid: result.valid === true,
        receipt_signature: result.receipt_signature === true,
        event_chain_proof: result.event_chain_proof === true,
        merkle_inclusion: result.merkle_inclusion === null ? null : result.merkle_inclusion === true,
        polygon_anchor: result.polygon_anchor === null ? null : result.polygon_anchor === true,
        failures: Array.isArray(result.failures) ? result.failures.filter((item) => typeof item === 'string').slice(0, 20) : [],
      }
    }
    try {
      const response = await api('/api/verify-proof', {
        method: 'POST',
        body: JSON.stringify({ proof: serverProofFrom(proofPackage) }),
      })
      return normalize(response)
    } catch (error) {
      // Invalid proofs are intentionally returned as 422 with a complete layer
      // report. Treat that as a verification result, not as network unavailability.
      if (error instanceof ApiError && error.status === 422 && error.payload && typeof error.payload === 'object') {
        try { return normalize(error.payload) } catch { /* fall through */ }
      }
      return { unavailable: true, message: error instanceof Error ? error.message : 'Server verification is unavailable' }
    }
  }

  function manifestBinding(manifest, receipt) {
    if (manifest == null) return null
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
    if (manifest.version !== '1' || manifest.commitment !== receipt.commitment || manifest.event_type !== receipt.event_type || manifest.occurred_at !== receipt.occurred_at) return false
    if (manifest.content_kind !== 'file' && manifest.content_kind !== 'string') return false
    if (!Number.isSafeInteger(manifest.content_length) || manifest.content_length < 0 || manifest.content_length > LOCAL_EVIDENCE_MAX_BYTES) return false
    return true
  }

  function polygonReference(anchor) {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return false
    return /^[a-f0-9]{64}$/i.test(anchor.merkle_root || '')
      && /^[a-f0-9]{64}$/i.test(anchor.manifest_hash || '')
      && /^0x[a-f0-9]{64}$/i.test(anchor.transaction_hash || '')
      && /^0x[a-f0-9]{40}$/i.test(anchor.contract_address || '')
      && typeof anchor.chain_id === 'string' && /^\d+$/.test(anchor.chain_id)
      && Number.isSafeInteger(anchor.leaf_index) && anchor.leaf_index >= 0
      && typeof anchor.confirmed_at === 'string' && Number.isFinite(Date.parse(anchor.confirmed_at))
  }

  async function verifyPackage(proofPackage, passcode, originalFile) {
    assertJsonBounds(proofPackage)
    const current = proofPackage.format === 'odproof' && proofPackage.version === 1
    const legacy = proofPackage.format === 'outside-docker-proof' && proofPackage.version === '1'
    if (!current && !legacy) throw new Error('Unsupported proof package')
    if (proofPackage.environment !== 'dev' && proofPackage.environment !== 'prod') throw new Error('Proof environment is missing or invalid')
    const receiptEnvelope = current ? record(proofPackage.receipt, 'Receipt envelope') : null
    if (current && typeof receiptEnvelope.canonical_json !== 'string') throw new Error('Canonical receipt JSON is missing')
    const signed = current ? {
      receipt: receiptEnvelope.payload,
      receipt_json: receiptEnvelope.canonical_json,
      signature: receiptEnvelope.signature,
      signing_key_id: receiptEnvelope.signing_key_id,
      signature_algorithm: receiptEnvelope.signature_algorithm,
    } : record(proofPackage.signed_receipt, 'Signed receipt')
    const receipt = record(signed.receipt, 'Receipt payload')
    const receiptOk = await verifySignedReceipt(signed, proofPackage.environment)
    const expectedProof = await sha256(`OD1|EVENT|${receipt.chain_id}|${receipt.position}|${receipt.received_at}|${receipt.commitment}|${receipt.previous_proof || ''}`)
    const chainOk = expectedProof === receipt.proof
    const eventBindingOk = current ? eventMatchesReceipt(proofPackage.event, receipt, proofPackage.environment) : true

    let manifestOk = null
    if (proofPackage.manifest != null) {
      manifestOk = manifestBinding(proofPackage.manifest, receipt)
        && await sha256(canonical(proofPackage.manifest)) === receipt.manifest_hash
    }

    let capsule = null
    let capsuleOk = null
    let capsuleContentOk = null
    let contentOk = null
    if (proofPackage.capsule) {
      if (!passcode) throw new Error('This package requires its separately shared passcode')
      capsule = await decryptCapsule(proofPackage.capsule, passcode, receipt.event_id)
      capsuleOk = await contentCommitment(capsule.content_hash, capsule.record_salt) === receipt.commitment
      if (proofPackage.manifest) capsuleOk = capsuleOk && capsule.content_kind === proofPackage.manifest.content_kind
      if (capsule.content_kind === 'string') {
        capsuleContentOk = typeof capsule.structured_text === 'string'
          && await sha256(encoder.encode(capsule.structured_text)) === capsule.content_hash
          && (!proofPackage.manifest || encoder.encode(capsule.structured_text).byteLength === proofPackage.manifest.content_length)
      } else if (capsule.content_kind === 'file') {
        capsuleContentOk = capsule.structured_text == null ? null : false
      } else {
        capsuleContentOk = false
      }
    }
    if (originalFile) {
      assertFileBound(originalFile, LOCAL_EVIDENCE_MAX_BYTES, 'Original comparison file')
      contentOk = Boolean(capsule)
        && await sha256(new Uint8Array(await originalFile.arrayBuffer())) === capsule.content_hash
        && (!proofPackage.manifest || originalFile.size === proofPackage.manifest.content_length)
    }

    let merkleOk = null
    const merkle = current && proofPackage.anchor ? { root: proofPackage.anchor.merkle_root, path: proofPackage.anchor.proof } : proofPackage.merkle
    if (merkle?.path) merkleOk = await verifyMerkle(receipt.event_id, receipt.proof, merkle)
    const anchorPresent = Boolean(current ? proofPackage.anchor : proofPackage.polygon || proofPackage.merkle)
    const anchorStateOk = current
      ? anchorPresent
        ? proofPackage.event?.anchor_status === 'anchored'
        : proofPackage.event?.anchor_status !== 'anchored'
      : null
    const polygonReferenceOk = current && proofPackage.anchor ? polygonReference(proofPackage.anchor) : null
    const server = current ? await verifyOnServer(proofPackage) : { unavailable: true, message: 'Legacy packages cannot be server-verified' }
    return {
      receiptOk,
      chainOk,
      eventBindingOk,
      manifestOk,
      capsuleOk,
      capsuleContentOk,
      contentOk,
      merkleOk,
      anchorPresent,
      anchorStateOk,
      polygonReferenceOk,
      server,
      receipt,
      capsule,
    }
  }

  async function verifyMerkle(eventId, eventProof, merkle) {
    if (!/^[a-f0-9]{64}$/i.test(eventProof || '') || !/^[a-f0-9]{64}$/i.test(merkle.root || '') || !Array.isArray(merkle.path) || merkle.path.length > 64) return false
    let current = await sha256(`OD1|MERKLE|${eventId}|${eventProof}`)
    for (const rawStep of merkle.path) {
      const step = record(rawStep, 'Merkle proof step')
      const side = step.side || step.position
      if ((side !== 'left' && side !== 'right') || !/^[a-f0-9]{64}$/i.test(step.hash || '')) return false
      const left = side === 'left' ? step.hash : current
      const right = side === 'left' ? current : step.hash
      current = await sha256(`OD1|NODE|${left}|${right}`)
    }
    return current === merkle.root.toLowerCase()
  }

  function renderVerification(result, target) {
    if (!target) return
    const optionalValid = (value) => value === null || value === true
    const serverInvalid = !result.server.unavailable && result.server.valid !== true
    const internalOk = result.receiptOk && result.chainOk && result.eventBindingOk
      && optionalValid(result.manifestOk) && optionalValid(result.capsuleOk)
      && optionalValid(result.capsuleContentOk) && optionalValid(result.contentOk)
      && optionalValid(result.merkleOk) && optionalValid(result.anchorStateOk)
      && optionalValid(result.polygonReferenceOk)
      && !serverInvalid
    const polygonVerified = result.anchorPresent && !result.server.unavailable && result.server.polygon_anchor === true
    const complete = internalOk && (!result.anchorPresent || polygonVerified)
    const partial = internalOk && result.anchorPresent && !polygonVerified
    const statusClass = complete ? 'ok' : partial ? 'partial' : 'fail'
    const status = complete ? 'VERIFIED' : partial ? 'PARTIALLY VERIFIED' : 'VERIFICATION FAILED'
    const summary = complete
      ? result.anchorPresent
        ? 'Every required layer, including the Polygon anchor, was verified.'
        : 'The signed pre-anchor proof is valid. Polygon anchoring is still pending.'
      : partial
        ? 'The included cryptographic layers are consistent, but the Polygon transaction was not independently confirmed.'
        : 'At least one required cryptographic layer failed.'
    const layer = (label, value, absent = 'Not included') => `<div class="verification-layer"><strong>${escapeHtml(label)}</strong><span>${value === null ? escapeHtml(absent) : value ? '✓ Valid' : '✕ Failed'}</span></div>`
    const serverLayer = result.server.unavailable
      ? layer('OD trusted verification', null, 'Unavailable')
      : layer('OD trusted verification', result.server.valid)
    const polygonLayer = result.anchorPresent
      ? layer('Polygon transaction', result.server.unavailable || result.server.polygon_anchor === null ? null : result.server.polygon_anchor, 'Not independently checked')
      : layer('Polygon transaction', null, 'Pending anchor')
    const receipt = result.receipt || {}
    target.innerHTML = `<div class="verification-status ${statusClass}"><strong>${status}</strong><p>${summary}</p></div>${layer('Receipt signature', result.receiptOk)}${layer('Signed event binding', result.eventBindingOk)}${layer('Hash-chain event', result.chainOk)}${layer('Manifest binding', result.manifestOk)}${layer('Content commitment', result.capsuleOk)}${layer('Capsule content hash', result.capsuleContentOk)}${layer('Original comparison', result.contentOk)}${layer('Merkle membership', result.merkleOk)}${layer('Anchor state', result.anchorStateOk)}${layer('Polygon reference', result.polygonReferenceOk)}${serverLayer}${polygonLayer}<div class="key-value"><dt>Event</dt><dd>${escapeHtml(receipt.event_id || '—')}</dd><dt>Received</dt><dd>${formatTime(receipt.received_at)}</dd><dt>Anchor</dt><dd>${escapeHtml(receipt.anchor_status || 'unknown')}</dd></div>`
  }

  async function handleVerifyForm(form, target) {
    const file = form?.elements?.proof_file?.files?.[0]
    if (!file) throw new Error('Choose an .odproof package')
    const proofPackage = await readProofPackage(file)
    const result = await verifyPackage(proofPackage, form.elements.passcode?.value || '', form.elements.original_file?.files?.[0])
    renderVerification(result, target)
  }

  async function initApp() {
    try {
      appState.session = await api('/api/session')
      csrfToken = appState.session.csrf_token || ''
    } catch {
      location.replace('/#login-card')
      return
    }
    const user = appState.session.user || appState.session.claims
    if (!user || (user.role !== 'supplier' && user.role !== 'verifier')) {
      location.replace('/#login-card')
      return
    }
    $$('.app-nav button[data-role="verifier"]').forEach((button) => { button.hidden = user.role !== 'verifier' })
    $$('.app-nav button[data-mode]').forEach((button) => {
      const mode = user.supplier_mode || ''
      button.hidden = user.role !== 'supplier' || !(mode === 'both' || mode === button.dataset.mode)
    })
    const supplierBilling = $('#supplier-billing-controls')
    const verifierBilling = $('#verifier-billing-note')
    if (supplierBilling) supplierBilling.hidden = user.role !== 'supplier'
    if (verifierBilling) verifierBilling.hidden = user.role !== 'verifier'
    $$('.app-nav button').forEach((button) => button.addEventListener('click', () => activateView(button.dataset.target)))
    activateView(location.hash.slice(1) || 'overview')
    $$('[data-dialog]').forEach((button) => button.addEventListener('click', () => {
      const form = $(`#${button.dataset.dialog}`)
      if (form) form.hidden = !form.hidden
    }))
    $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.replace('/') })

    $('#case-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { await api('/api/h/cases', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); event.currentTarget.reset(); event.currentTarget.hidden = true; await Promise.all([loadCases(), loadDashboard()]); notice('Case created.') } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#event-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { await submitHumanEvent(event.currentTarget) } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#api-key-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { const result = await api('/api/api-keys', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); $('#api-key-result').hidden = false; $('#api-key-result').textContent = `Copy now — this key is shown once: ${result.api_key}`; event.currentTarget.reset(); event.currentTarget.hidden = true; await loadMachine() } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#source-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try {
        const idempotencyKey = event.currentTarget.dataset.idempotencyKey || `source-${crypto.randomUUID()}`
        event.currentTarget.dataset.idempotencyKey = idempotencyKey
        await api('/api/v1/sources', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(formObject(event.currentTarget)),
        })
        delete event.currentTarget.dataset.idempotencyKey
        event.currentTarget.reset(); event.currentTarget.hidden = true; await loadMachine(); notice('Machine source registered.')
      } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#share-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { const result = await api('/api/shares', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); $('#share-result').hidden = false; $('#share-result').textContent = result.share_url; event.currentTarget.hidden = true; await loadShares() } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#workspace-verify-form').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { await handleVerifyForm(event.currentTarget, $('#workspace-verify-result')) } catch (error) { $('#workspace-verify-result').innerHTML = `<div class="verification-status fail"><strong>VERIFICATION FAILED</strong><p>${escapeHtml(error.message)}</p></div>` } finally { setBusy(event.currentTarget, false) }
    })
    $('#billing-checkout').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { const result = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); location.assign(result.checkout_url) } catch (error) { notice(error.message, 'error'); setBusy(event.currentTarget, false) }
    })
    $('#billing-portal').addEventListener('click', async () => {
      try { const result = await api('/api/billing/portal', { method: 'POST' }); location.assign(result.portal_url) } catch (error) { notice(error.message, 'error') }
    })
    $('#totp-start').addEventListener('submit', async (event) => {
      event.preventDefault()
      try {
        const result = await api('/api/security/totp/start', { method: 'POST' })
        $('#totp-enrollment').hidden = false
        $('#totp-uri').textContent = result.manual_secret ? `Manual secret: ${result.manual_secret}` : result.otpauth_uri
        if (result.qr_data_url && $('#totp-qr')) {
          $('#totp-qr').src = result.qr_data_url
          $('#totp-qr').hidden = false
        }
      } catch (error) { notice(error.message, 'error') }
    })
    $('#totp-confirm').addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(event.currentTarget, true)
      try { const result = await api('/api/security/totp/confirm', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }); $('#recovery-codes').textContent = `Store once: ${result.recovery_codes.join('  ')}`; notice('TOTP enabled.') } catch (error) { notice(error.message, 'error') } finally { setBusy(event.currentTarget, false) }
    })
    $('#revoke-sessions').addEventListener('click', async () => {
      try { await api('/api/security/sessions/revoke', { method: 'POST' }); notice('Other sessions revoked. Sign in again on those devices.') } catch (error) { notice(error.message, 'error') }
    })

    const loaders = [loadDashboard()]
    if (user.role === 'supplier' && (user.supplier_mode === 'both' || user.supplier_mode === 'H')) loaders.push(loadCases())
    if (user.role === 'supplier' && (user.supplier_mode === 'both' || user.supplier_mode === 'M')) loaders.push(loadMachine())
    if (user.role === 'verifier') loaders.push(loadVerifier())
    loaders.push(loadShares())
    const results = await Promise.allSettled(loaders)
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) notice(failure.reason?.message || 'Some workspace data could not be loaded.', 'error')
    $('#totp-state').textContent = user.totp_enabled ? 'Enabled' : 'Not enabled'
  }

  async function initVerify() {
    const form = $('#public-verify-form')
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); setBusy(form, true)
      try { await handleVerifyForm(form, $('#public-verify-result')) } catch (error) { $('#public-verify-result').innerHTML = `<div class="verification-status fail"><strong>VERIFICATION FAILED</strong><p>${escapeHtml(error.message)}</p></div>` } finally { setBusy(form, false) }
    })
    const token = $('[data-page=verify]')?.dataset.shareToken
    if (token) {
      try {
        const shared = await api(`/api/public/shares/${encodeURIComponent(token)}`)
        const target = $('#public-verify-result')
        const scope = shared?.scope || {}
        const events = Array.isArray(shared?.events) ? shared.events : []
        target.innerHTML = `<h2>${escapeHtml(scope.title || 'Shared evidence')}</h2><p>${escapeHtml(scope.summary || 'Supplier-shared evidence')}</p>${events.map((event) => {
          const receipt = event?.receipt || event || {}
          const eventId = event?.id || receipt.event_id
          return `<article class="timeline-event"><header><strong>${escapeHtml(receipt.event_type || receipt.action || 'Event')}</strong><span>#${escapeHtml(receipt.position ?? '—')}</span></header><code>${escapeHtml(receipt.proof || 'proof unavailable')}</code><div class="record-actions"><a class="quiet-button" href="/api/public/shares/${encodeURIComponent(token)}/events/${encodeURIComponent(eventId)}/proof" target="_blank" rel="noopener">Portable proof</a>${shared.include_pdf ? `<a class="quiet-button" href="/api/public/shares/${encodeURIComponent(token)}/events/${encodeURIComponent(eventId)}/proof.pdf" target="_blank" rel="noopener">PDF</a>` : ''}</div></article>`
        }).join('')}<p class="hint">Content comparison still requires the original file and any separately shared capsule passcode.</p>`
      } catch (error) {
        $('#public-verify-result').innerHTML = `<div class="verification-status fail"><strong>SHARE UNAVAILABLE</strong><p>${escapeHtml(error.message)}</p></div>`
      }
    }
  }

  if (page === 'landing') initLanding()
  else if (page === 'app') initApp()
  else if (page === 'verify') initVerify()
})()
