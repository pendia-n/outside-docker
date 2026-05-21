type LogLevel = "info" | "warn" | "error";

interface AppEnv extends Env {
	DB: D1Database;
	ASSETS: {
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	};
	APP_NAME?: string;
	COOKIE_NAME?: string;
	SESSION_TTL_HOURS?: string;
	FREE_CREDITS?: string;
	RATE_LIMIT_WINDOW_SEC?: string;
	RATE_LIMIT_ANON?: string;
	RATE_LIMIT_AUTH?: string;
	APP_BASE_URL?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_PRICE_PACK_SMALL?: string;
	STRIPE_PRICE_PACK_MEDIUM?: string;
	STRIPE_PRICE_PACK_LARGE?: string;
	STRIPE_API_BASE?: string;
}

interface AppConfig {
	appName: string;
	cookieName: string;
	sessionTtlHours: number;
	freeCredits: number;
	rateLimitWindowSec: number;
	rateLimitAnon: number;
	rateLimitAuth: number;
	appBaseUrl: string;
	stripeApiBase: string;
}

interface AuthContext {
	userId: string;
	orgId: string;
	username: string;
	sessionId: string;
}

interface PackConfig {
	packId: "small" | "medium" | "large";
	priceId: string;
	credits: number;
}

interface ApiError extends Error {
	status: number;
	code: string;
}

type RequestMeta = {
	method: string;
	path: string;
	requestId: string;
	ip: string;
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const meta: RequestMeta = {
			method: request.method.toUpperCase(),
			path: new URL(request.url).pathname,
			requestId: crypto.randomUUID(),
			ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
		};
		const config = getConfig(env, request);

		try {
			if (meta.path.startsWith("/api/")) {
				if (meta.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: CORS_HEADERS });
				}
				return await routeApi(request, env, config, meta);
			}
			return env.ASSETS.fetch(request);
		} catch (err) {
			const appErr = normalizeError(err);
			logEvent("error", "request_failed", {
				requestId: meta.requestId,
				path: meta.path,
				method: meta.method,
				status: appErr.status,
				code: appErr.code,
				message: appErr.message,
			});
			return jsonResponse(
				{
					error: appErr.message,
					code: appErr.code,
					requestId: meta.requestId,
				},
				appErr.status,
			);
		}
	},
} satisfies ExportedHandler<AppEnv>;

async function routeApi(
	request: Request,
	env: AppEnv,
	config: AppConfig,
	meta: RequestMeta,
): Promise<Response> {
	const url = new URL(request.url);

	if (meta.path === "/api/health" && meta.method === "GET") {
		return jsonResponse({
			ok: true,
			service: config.appName,
			time: new Date().toISOString(),
		});
	}

	if (meta.path === "/api/register" && meta.method === "POST") {
		await enforceRateLimit(env, `anon:register:${meta.ip}`, config.rateLimitAnon, config.rateLimitWindowSec);
		const body = await readJsonBody(request);
		const username = sanitizeUsername(body.username);
		const password = sanitizePassword(body.password);
		const organizationName = sanitizeText(body.organizationName, 80, "organizationName");
		return await handleRegister(env, config, username, password, organizationName);
	}

	if (meta.path === "/api/login" && meta.method === "POST") {
		await enforceRateLimit(env, `anon:login:${meta.ip}`, config.rateLimitAnon, config.rateLimitWindowSec);
		const body = await readJsonBody(request);
		const username = sanitizeUsername(body.username);
		const password = sanitizePassword(body.password);
		return await handleLogin(env, config, username, password);
	}

	if (meta.path === "/api/logout" && meta.method === "POST") {
		return await handleLogout(request, env, config);
	}

	if (meta.path === "/api/stripe/webhook" && meta.method === "POST") {
		return await handleStripeWebhook(request, env);
	}

	const auth = await requireAuth(request, env, config);
	await enforceRateLimit(env, `auth:${auth.userId}:${meta.path}`, config.rateLimitAuth, config.rateLimitWindowSec);

	if (meta.path === "/api/me" && meta.method === "GET") {
		const balance = await getCreditBalance(env, auth.orgId);
		return jsonResponse({
			userId: auth.userId,
			orgId: auth.orgId,
			username: auth.username,
			credits: balance,
		});
	}

	if (meta.path === "/api/shipments" && meta.method === "GET") {
		return await listShipments(env, auth.orgId);
	}

	if (meta.path === "/api/shipments" && meta.method === "POST") {
		const body = await readJsonBody(request);
		return await createShipment(env, auth, body);
	}

	if (meta.path.match(/^\/api\/shipments\/[^/]+\/claim-packet$/) && meta.method === "POST") {
		const shipmentId = meta.path.split("/")[3];
		return await generateClaimPacket(env, config, auth, shipmentId);
	}

	if (meta.path.match(/^\/api\/shipments\/[^/]+\/status$/) && meta.method === "POST") {
		const shipmentId = meta.path.split("/")[3];
		const body = await readJsonBody(request);
		const status = sanitizeClaimStatus(body.status);
		return await updateClaimStatus(env, auth.orgId, shipmentId, status);
	}

	if (meta.path === "/api/credits/purchase" && meta.method === "POST") {
		const body = await readJsonBody(request);
		const packId = sanitizePackId(body.packId);
		return await createStripeCheckout(request, env, config, auth.orgId, packId);
	}

	throw apiError(404, "NOT_FOUND", "API route not found");
}

async function handleRegister(
	env: AppEnv,
	config: AppConfig,
	username: string,
	password: string,
	organizationName: string,
): Promise<Response> {
	const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?1 LIMIT 1").bind(username).first();
	if (existing) {
		throw apiError(409, "USERNAME_TAKEN", "Username is already in use");
	}

	const now = new Date().toISOString();
	const orgId = crypto.randomUUID();
	const userId = crypto.randomUUID();
	const { salt, hash } = await hashPassword(password);
	const session = await createSession(env, config, userId);

	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
		)
			.bind(orgId, organizationName, now),
		env.DB.prepare(
			"INSERT INTO users (id, org_id, username, password_salt, password_hash, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'owner', ?6, ?6)",
		)
			.bind(userId, orgId, username, salt, hash, now),
		env.DB.prepare("INSERT INTO credit_wallets (org_id, balance, updated_at) VALUES (?1, ?2, ?3)").bind(
			orgId,
			config.freeCredits,
			now,
		),
		env.DB.prepare(
			"INSERT INTO credit_ledger (id, org_id, delta, reason, metadata_json, created_at) VALUES (?1, ?2, ?3, 'signup_bonus', ?4, ?5)",
		)
			.bind(crypto.randomUUID(), orgId, config.freeCredits, JSON.stringify({ source: "register" }), now),
	]);

	logEvent("info", "user_registered", { userId, orgId, username });
	return jsonResponse(
		{
			message: "Registration successful",
			userId,
			orgId,
			credits: config.freeCredits,
		},
		201,
		session.cookieHeader,
	);
}

async function handleLogin(env: AppEnv, config: AppConfig, username: string, password: string): Promise<Response> {
	const row = await env.DB.prepare(
		"SELECT id, org_id, password_salt, password_hash FROM users WHERE username = ?1 LIMIT 1",
	)
		.bind(username)
		.first<{ id: string; org_id: string; password_salt: string; password_hash: string }>();
	if (!row) {
		throw apiError(401, "INVALID_CREDENTIALS", "Invalid username or password");
	}

	const valid = await verifyPassword(password, row.password_salt, row.password_hash);
	if (!valid) {
		throw apiError(401, "INVALID_CREDENTIALS", "Invalid username or password");
	}

	const session = await createSession(env, config, row.id);
	const balance = await getCreditBalance(env, row.org_id);
	logEvent("info", "user_logged_in", { userId: row.id, orgId: row.org_id });

	return jsonResponse(
		{
			message: "Login successful",
			userId: row.id,
			orgId: row.org_id,
			credits: balance,
		},
		200,
		session.cookieHeader,
	);
}

async function handleLogout(request: Request, env: AppEnv, config: AppConfig): Promise<Response> {
	const token = extractSessionToken(request, config.cookieName);
	if (token) {
		const tokenHash = await sha256Hex(token);
		await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
	}
	return jsonResponse({ message: "Logged out" }, 200, `${config.cookieName}=deleted; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

async function requireAuth(request: Request, env: AppEnv, config: AppConfig): Promise<AuthContext> {
	const token = extractSessionToken(request, config.cookieName);
	if (!token) {
		throw apiError(401, "AUTH_REQUIRED", "Authentication required");
	}
	const tokenHash = await sha256Hex(token);
	const nowMs = Date.now();
	const row = await env.DB.prepare(
		`SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.org_id, u.username
		 FROM sessions s
		 JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = ?1
		 LIMIT 1`,
	)
		.bind(tokenHash)
		.first<{ session_id: string; expires_at: string; user_id: string; org_id: string; username: string }>();
	if (!row) {
		throw apiError(401, "AUTH_REQUIRED", "Invalid session");
	}
	if (Date.parse(row.expires_at) <= nowMs) {
		await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(row.session_id).run();
		throw apiError(401, "SESSION_EXPIRED", "Session expired");
	}
	return {
		userId: row.user_id,
		orgId: row.org_id,
		username: row.username,
		sessionId: row.session_id,
	};
}

async function createShipment(env: AppEnv, auth: AuthContext, body: Record<string, unknown>): Promise<Response> {
	const supplierName = sanitizeText(body.supplierName, 100, "supplierName");
	const supplierReference = sanitizeOptionalText(body.supplierReference, 120);
	const deliveryDate = sanitizeIsoDate(body.deliveryDate);
	const notes = sanitizeOptionalText(body.notes, 500);
	const discrepancies = sanitizeDiscrepancies(body.discrepancies);
	if (discrepancies.length === 0) {
		throw apiError(400, "INVALID_INPUT", "At least one discrepancy is required");
	}

	const now = new Date().toISOString();
	const shipmentId = crypto.randomUUID();
	const batch: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO shipments
			(id, org_id, supplier_name, supplier_reference, delivery_date, notes, created_by, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
		)
			.bind(shipmentId, auth.orgId, supplierName, supplierReference, deliveryDate, notes, auth.userId, now),
	];

	for (const discrepancy of discrepancies) {
		batch.push(
			env.DB.prepare(
				`INSERT INTO discrepancies
				(id, shipment_id, kind, sku, expected_qty, received_qty, damaged_qty, notes, created_at)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
			).bind(
				crypto.randomUUID(),
				shipmentId,
				discrepancy.kind,
				discrepancy.sku,
				discrepancy.expectedQty,
				discrepancy.receivedQty,
				discrepancy.damagedQty,
				discrepancy.notes,
				now,
			),
		);
	}

	await env.DB.batch(batch);
	logEvent("info", "shipment_created", {
		shipmentId,
		orgId: auth.orgId,
		discrepancyCount: discrepancies.length,
	});

	return jsonResponse({ message: "Shipment created", shipmentId }, 201);
}

async function listShipments(env: AppEnv, orgId: string): Promise<Response> {
	const shipments = await env.DB.prepare(
		`SELECT
			s.id,
			s.supplier_name,
			s.supplier_reference,
			s.delivery_date,
			s.notes,
			s.created_at,
			s.updated_at,
			COALESCE(c.status, 'draft') AS claim_status,
			COALESCE(c.credits_spent, 0) AS credits_spent
		FROM shipments s
		LEFT JOIN claims c ON c.shipment_id = s.id
		WHERE s.org_id = ?1
		ORDER BY s.created_at DESC
		LIMIT 200`,
	)
		.bind(orgId)
		.all();
	return jsonResponse({ shipments: shipments.results ?? [] });
}

async function generateClaimPacket(
	env: AppEnv,
	config: AppConfig,
	auth: AuthContext,
	shipmentId: string,
): Promise<Response> {
	const shipment = await env.DB.prepare(
		`SELECT id, supplier_name, supplier_reference, delivery_date, notes, created_at
		 FROM shipments
		 WHERE id = ?1 AND org_id = ?2
		 LIMIT 1`,
	)
		.bind(shipmentId, auth.orgId)
		.first<{
			id: string;
			supplier_name: string;
			supplier_reference: string | null;
			delivery_date: string;
			notes: string | null;
			created_at: string;
		}>();
	if (!shipment) {
		throw apiError(404, "SHIPMENT_NOT_FOUND", "Shipment not found");
	}

	const discrepancyRows = await env.DB.prepare(
		`SELECT kind, sku, expected_qty, received_qty, damaged_qty, notes, created_at
		 FROM discrepancies
		 WHERE shipment_id = ?1
		 ORDER BY created_at ASC`,
	)
		.bind(shipmentId)
		.all<{
			kind: string;
			sku: string;
			expected_qty: number | null;
			received_qty: number | null;
			damaged_qty: number | null;
			notes: string | null;
			created_at: string;
		}>();
	const discrepancies = discrepancyRows.results ?? [];
	if (discrepancies.length === 0) {
		throw apiError(400, "NO_DISCREPANCIES", "No discrepancies found for shipment");
	}

	const wallet = await getCreditBalance(env, auth.orgId);
	if (wallet < 1) {
		throw apiError(402, "INSUFFICIENT_CREDITS", "Not enough credits. Please purchase a credit pack.");
	}

	const now = new Date().toISOString();
	const packet = {
		packetId: crypto.randomUUID(),
		generatedAt: now,
		generatedBy: auth.username,
		organizationId: auth.orgId,
		shipment: {
			id: shipment.id,
			supplierName: shipment.supplier_name,
			supplierReference: shipment.supplier_reference,
			deliveryDate: shipment.delivery_date,
			notes: shipment.notes,
			recordedAt: shipment.created_at,
		},
		discrepancies: discrepancies.map((d) => ({
			kind: d.kind,
			sku: d.sku,
			expectedQty: d.expected_qty,
			receivedQty: d.received_qty,
			damagedQty: d.damaged_qty,
			notes: d.notes,
			recordedAt: d.created_at,
		})),
		disclaimer:
			"This packet is an operational evidence summary generated by DockDocket and does not guarantee claim outcomes.",
	};

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO claims
			(id, shipment_id, org_id, status, packet_json, credits_spent, created_by, created_at, updated_at)
			VALUES (?1, ?2, ?3, 'draft', ?4, 1, ?5, ?6, ?6)
			ON CONFLICT(shipment_id) DO UPDATE SET
				packet_json = excluded.packet_json,
				credits_spent = claims.credits_spent + 1,
				updated_at = excluded.updated_at`,
		)
			.bind(crypto.randomUUID(), shipmentId, auth.orgId, JSON.stringify(packet), auth.userId, now),
		env.DB.prepare("UPDATE credit_wallets SET balance = balance - 1, updated_at = ?2 WHERE org_id = ?1")
			.bind(auth.orgId, now),
		env.DB.prepare(
			"INSERT INTO credit_ledger (id, org_id, delta, reason, metadata_json, created_at) VALUES (?1, ?2, -1, 'claim_packet_generation', ?3, ?4)",
		)
			.bind(crypto.randomUUID(), auth.orgId, JSON.stringify({ shipmentId }), now),
	]);

	logEvent("info", "claim_packet_generated", { orgId: auth.orgId, shipmentId });

	return jsonResponse({
		message: "Claim packet generated",
		packet,
		creditsRemaining: wallet - 1,
	});
}

async function updateClaimStatus(
	env: AppEnv,
	orgId: string,
	shipmentId: string,
	status: "draft" | "submitted" | "accepted" | "rejected" | "partial",
): Promise<Response> {
	const now = new Date().toISOString();
	const result = await env.DB.prepare(
		"UPDATE claims SET status = ?1, updated_at = ?2 WHERE org_id = ?3 AND shipment_id = ?4",
	)
		.bind(status, now, orgId, shipmentId)
		.run();
	if (!result.success || !result.meta.changes) {
		throw apiError(404, "CLAIM_NOT_FOUND", "Claim not found for shipment");
	}
	return jsonResponse({ message: "Claim status updated", status });
}

async function createStripeCheckout(
	request: Request,
	env: AppEnv,
	config: AppConfig,
	orgId: string,
	packId: "small" | "medium" | "large",
): Promise<Response> {
	const secretKey = env.STRIPE_SECRET_KEY;
	if (!secretKey) {
		throw apiError(503, "BILLING_NOT_CONFIGURED", "Stripe secret key is not configured");
	}
	const pack = getPackConfig(env, packId);
	const origin = config.appBaseUrl || new URL(request.url).origin;
	const successUrl = `${origin}/?purchase=success`;
	const cancelUrl = `${origin}/?purchase=cancelled`;

	const body = new URLSearchParams();
	body.set("mode", "payment");
	body.set("success_url", successUrl);
	body.set("cancel_url", cancelUrl);
	body.set("line_items[0][price]", pack.priceId);
	body.set("line_items[0][quantity]", "1");
	body.set("metadata[org_id]", orgId);
	body.set("metadata[pack_id]", pack.packId);

	const resp = await fetch(`${config.stripeApiBase}/v1/checkout/sessions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secretKey}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});
	const payload = await resp.json<Record<string, unknown>>();
	if (!resp.ok) {
		throw apiError(502, "STRIPE_CHECKOUT_FAILED", `Stripe checkout creation failed: ${JSON.stringify(payload)}`);
	}

	const sessionId = String(payload.id ?? "");
	const checkoutUrl = String(payload.url ?? "");
	if (!sessionId || !checkoutUrl) {
		throw apiError(502, "STRIPE_CHECKOUT_FAILED", "Stripe checkout session missing id or url");
	}

	await env.DB.prepare(
		`INSERT INTO purchases
		(id, org_id, pack_id, provider, provider_ref, amount_cents, currency, status, credits_granted, created_at, updated_at)
		VALUES (?1, ?2, ?3, 'stripe', ?4, 0, 'usd', 'pending', ?5, ?6, ?6)`,
	)
		.bind(crypto.randomUUID(), orgId, pack.packId, sessionId, pack.credits, new Date().toISOString())
		.run();

	return jsonResponse({ checkoutUrl, sessionId });
}

async function handleStripeWebhook(request: Request, env: AppEnv): Promise<Response> {
	const secret = env.STRIPE_WEBHOOK_SECRET;
	if (!secret) {
		throw apiError(503, "WEBHOOK_NOT_CONFIGURED", "Stripe webhook secret is not configured");
	}
	const raw = await request.text();
	const signature = request.headers.get("stripe-signature") ?? "";
	const verified = await verifyStripeSignature(raw, signature, secret);
	if (!verified) {
		throw apiError(401, "INVALID_STRIPE_SIGNATURE", "Stripe signature verification failed");
	}

	const event = JSON.parse(raw) as {
		type?: string;
		data?: { object?: Record<string, unknown> };
	};
	if (event.type !== "checkout.session.completed") {
		return jsonResponse({ message: "Event ignored" }, 200);
	}

	const object = event.data?.object ?? {};
	const sessionId = String(object.id ?? "");
	const metadata = (object.metadata as Record<string, string> | undefined) ?? {};
	const orgId = metadata.org_id ?? "";
	if (!sessionId || !orgId) {
		throw apiError(400, "INVALID_WEBHOOK_PAYLOAD", "Missing session metadata");
	}

	const purchase = await env.DB.prepare(
		"SELECT id, status, credits_granted FROM purchases WHERE provider = 'stripe' AND provider_ref = ?1 LIMIT 1",
	)
		.bind(sessionId)
		.first<{ id: string; status: string; credits_granted: number }>();
	if (!purchase) {
		throw apiError(404, "PURCHASE_NOT_FOUND", "Purchase not found");
	}
	if (purchase.status === "paid") {
		return jsonResponse({ message: "Purchase already processed" });
	}

	const now = new Date().toISOString();
	await env.DB.batch([
		env.DB.prepare("UPDATE purchases SET status = 'paid', updated_at = ?2 WHERE id = ?1").bind(purchase.id, now),
		env.DB.prepare("UPDATE credit_wallets SET balance = balance + ?2, updated_at = ?3 WHERE org_id = ?1").bind(
			orgId,
			purchase.credits_granted,
			now,
		),
		env.DB.prepare(
			"INSERT INTO credit_ledger (id, org_id, delta, reason, metadata_json, created_at) VALUES (?1, ?2, ?3, 'credit_pack_purchase', ?4, ?5)",
		)
			.bind(crypto.randomUUID(), orgId, purchase.credits_granted, JSON.stringify({ sessionId }), now),
	]);

	logEvent("info", "stripe_purchase_processed", { orgId, sessionId, credits: purchase.credits_granted });
	return jsonResponse({ message: "Webhook processed" });
}

async function getCreditBalance(env: AppEnv, orgId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT balance FROM credit_wallets WHERE org_id = ?1 LIMIT 1")
		.bind(orgId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

async function createSession(
	env: AppEnv,
	config: AppConfig,
	userId: string,
): Promise<{ token: string; cookieHeader: string }> {
	const token = createSessionToken();
	const tokenHash = await sha256Hex(token);
	const now = Date.now();
	const expiresAt = new Date(now + config.sessionTtlHours * 60 * 60 * 1000).toISOString();
	await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
		.bind(crypto.randomUUID(), userId, tokenHash, expiresAt, new Date(now).toISOString())
		.run();
	const cookieHeader =
		`${config.cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${config.sessionTtlHours * 3600}`;
	return { token, cookieHeader };
}

async function enforceRateLimit(
	env: AppEnv,
	key: string,
	limit: number,
	windowSec: number,
): Promise<void> {
	const nowSec = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		"SELECT key, window_start, count FROM rate_limits WHERE key = ?1 LIMIT 1",
	)
		.bind(key)
		.first<{ key: string; window_start: number; count: number }>();
	if (!row) {
		await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)").bind(key, nowSec).run();
		return;
	}

	const elapsed = nowSec - row.window_start;
	if (elapsed >= windowSec) {
		await env.DB.prepare("UPDATE rate_limits SET window_start = ?2, count = 1 WHERE key = ?1").bind(key, nowSec).run();
		return;
	}
	if (row.count >= limit) {
		throw apiError(429, "RATE_LIMITED", "Too many requests, try again later");
	}
	await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?1").bind(key).run();
}

function getConfig(env: AppEnv, request: Request): AppConfig {
	return {
		appName: (env.APP_NAME ?? "DockDocket").trim(),
		cookieName: (env.COOKIE_NAME ?? "dockdocket_session").trim(),
		sessionTtlHours: parseIntEnv(env.SESSION_TTL_HOURS, 24, 1, 168),
		freeCredits: parseIntEnv(env.FREE_CREDITS, 5, 0, 10000),
		rateLimitWindowSec: parseIntEnv(env.RATE_LIMIT_WINDOW_SEC, 60, 10, 3600),
		rateLimitAnon: parseIntEnv(env.RATE_LIMIT_ANON, 20, 1, 1000),
		rateLimitAuth: parseIntEnv(env.RATE_LIMIT_AUTH, 120, 1, 5000),
		appBaseUrl: (env.APP_BASE_URL ?? new URL(request.url).origin).trim(),
		stripeApiBase: (env.STRIPE_API_BASE ?? "https://api.stripe.com").trim(),
	};
}

function getPackConfig(env: AppEnv, packId: "small" | "medium" | "large"): PackConfig {
	const mapping = {
		small: {
			priceId: env.STRIPE_PRICE_PACK_SMALL ?? "",
			credits: 50,
		},
		medium: {
			priceId: env.STRIPE_PRICE_PACK_MEDIUM ?? "",
			credits: 200,
		},
		large: {
			priceId: env.STRIPE_PRICE_PACK_LARGE ?? "",
			credits: 1000,
		},
	}[packId];
	if (!mapping.priceId) {
		throw apiError(503, "BILLING_NOT_CONFIGURED", `Stripe price ID missing for pack: ${packId}`);
	}
	return {
		packId,
		priceId: mapping.priceId,
		credits: mapping.credits,
	};
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		throw apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Request must use application/json");
	}
	try {
		const body = (await request.json()) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new Error("Invalid JSON object");
		}
		return body as Record<string, unknown>;
	} catch {
		throw apiError(400, "INVALID_JSON", "Invalid JSON body");
	}
}

function sanitizeUsername(value: unknown): string {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", "username is required");
	}
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(normalized)) {
		throw apiError(400, "INVALID_INPUT", "username must be 3-30 chars: lowercase letters, numbers, '_' or '-'");
	}
	return normalized;
}

function sanitizePassword(value: unknown): string {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", "password is required");
	}
	if (value.length < 10 || value.length > 128) {
		throw apiError(400, "INVALID_INPUT", "password must be 10-128 characters");
	}
	return value;
}

function sanitizeText(value: unknown, maxLen: number, fieldName: string): string {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", `${fieldName} must be a string`);
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		throw apiError(400, "INVALID_INPUT", `${fieldName} is required`);
	}
	if (normalized.length > maxLen) {
		throw apiError(400, "INVALID_INPUT", `${fieldName} must be <= ${maxLen} chars`);
	}
	return normalized;
}

function sanitizeOptionalText(value: unknown, maxLen: number): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	return sanitizeText(value, maxLen, "field");
}

function sanitizeIsoDate(value: unknown): string {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", "deliveryDate must be a string");
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf())) {
		throw apiError(400, "INVALID_INPUT", "deliveryDate must be a valid ISO date");
	}
	return parsed.toISOString();
}

function sanitizeDiscrepancies(value: unknown): Array<{
	kind: string;
	sku: string;
	expectedQty: number | null;
	receivedQty: number | null;
	damagedQty: number | null;
	notes: string | null;
}> {
	if (!Array.isArray(value) || value.length === 0) {
		throw apiError(400, "INVALID_INPUT", "discrepancies must be a non-empty array");
	}
	if (value.length > 100) {
		throw apiError(400, "INVALID_INPUT", "discrepancies cannot exceed 100 items");
	}
	return value.map((item, idx) => {
		if (!item || typeof item !== "object") {
			throw apiError(400, "INVALID_INPUT", `discrepancies[${idx}] must be an object`);
		}
		const record = item as Record<string, unknown>;
		const kind = sanitizeText(record.kind, 40, `discrepancies[${idx}].kind`);
		const sku = sanitizeText(record.sku, 80, `discrepancies[${idx}].sku`);
		const expectedQty = sanitizeNullableInt(record.expectedQty, `discrepancies[${idx}].expectedQty`);
		const receivedQty = sanitizeNullableInt(record.receivedQty, `discrepancies[${idx}].receivedQty`);
		const damagedQty = sanitizeNullableInt(record.damagedQty, `discrepancies[${idx}].damagedQty`);
		const notes = sanitizeOptionalText(record.notes, 400);
		return { kind, sku, expectedQty, receivedQty, damagedQty, notes };
	});
}

function sanitizeNullableInt(value: unknown, fieldName: string): number | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		throw apiError(400, "INVALID_INPUT", `${fieldName} must be a non-negative integer`);
	}
	return value;
}

function sanitizeClaimStatus(value: unknown): "draft" | "submitted" | "accepted" | "rejected" | "partial" {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", "status must be a string");
	}
	const normalized = value.trim().toLowerCase();
	const allowed = new Set(["draft", "submitted", "accepted", "rejected", "partial"]);
	if (!allowed.has(normalized)) {
		throw apiError(400, "INVALID_INPUT", "status must be one of draft, submitted, accepted, rejected, partial");
	}
	return normalized as "draft" | "submitted" | "accepted" | "rejected" | "partial";
}

function sanitizePackId(value: unknown): "small" | "medium" | "large" {
	if (typeof value !== "string") {
		throw apiError(400, "INVALID_INPUT", "packId must be a string");
	}
	const normalized = value.trim().toLowerCase();
	if (normalized !== "small" && normalized !== "medium" && normalized !== "large") {
		throw apiError(400, "INVALID_INPUT", "packId must be one of small, medium, large");
	}
	return normalized;
}

function extractSessionToken(request: Request, cookieName: string): string | null {
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) {
		return null;
	}
	const cookies = cookieHeader.split(";").map((v) => v.trim());
	const prefix = `${cookieName}=`;
	for (const cookie of cookies) {
		if (cookie.startsWith(prefix)) {
			return cookie.slice(prefix.length);
		}
	}
	return null;
}

function createSessionToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let out = "";
	for (const b of bytes) {
		out += b.toString(16).padStart(2, "0");
	}
	return out;
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
	const saltBytes = crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: saltBytes,
			iterations: 210_000,
			hash: "SHA-256",
		},
		keyMaterial,
		256,
	);
	return {
		salt: bytesToHex(saltBytes),
		hash: bytesToHex(new Uint8Array(bits)),
	};
}

async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
	const salt = hexToBytes(saltHex);
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: 210_000,
			hash: "SHA-256",
		},
		keyMaterial,
		256,
	);
	const computed = bytesToHex(new Uint8Array(bits));
	return timingSafeEqualHex(computed, hashHex);
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return bytesToHex(new Uint8Array(digest));
}

async function verifyStripeSignature(rawBody: string, header: string, secret: string): Promise<boolean> {
	const parts = header.split(",").map((part) => part.trim());
	let timestamp = "";
	let signature = "";
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key === "t") {
			timestamp = value ?? "";
		}
		if (key === "v1") {
			signature = value ?? "";
		}
	}
	if (!timestamp || !signature) {
		return false;
	}
	const payload = `${timestamp}.${rawBody}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	const expected = bytesToHex(new Uint8Array(sigBuffer));
	return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let mismatch = 0;
	for (let i = 0; i < a.length; i += 1) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
		throw apiError(500, "INVALID_HASH_FORMAT", "Stored hash format is invalid");
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, "0");
	}
	return out;
}

function parseIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
		return parsed;
	}
	return fallback;
}

function jsonResponse(body: unknown, status = 200, setCookie?: string): Response {
	const headers = new Headers({
		...CORS_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
	});
	if (setCookie) {
		headers.set("Set-Cookie", setCookie);
	}
	return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function apiError(status: number, code: string, message: string): ApiError {
	const err = new Error(message) as ApiError;
	err.status = status;
	err.code = code;
	return err;
}

function normalizeError(err: unknown): ApiError {
	if (typeof err === "object" && err && "status" in err && "code" in err && "message" in err) {
		return err as ApiError;
	}
	return apiError(500, "INTERNAL_ERROR", "Unexpected server error");
}

function logEvent(level: LogLevel, event: string, data: Record<string, unknown>): void {
	const line = {
		ts: new Date().toISOString(),
		level,
		event,
		...data,
	};
	console.log(JSON.stringify(line));
}
