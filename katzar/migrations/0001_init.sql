PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id),
 recipient_id TEXT REFERENCES users(id), invite_token_hash TEXT NOT NULL UNIQUE,
 tier TEXT NOT NULL CHECK(tier IN ('free','full')),
 duration_seconds INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending_payment','inviting','active','ended')),
 created_at INTEGER NOT NULL, invite_expires_at INTEGER NOT NULL,
 joined_at INTEGER, expires_at INTEGER, recipient_left_at INTEGER, ended_at INTEGER,
 checkout_session_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS rooms_creator ON rooms(creator_id, status);
CREATE INDEX IF NOT EXISTS rooms_recipient ON rooms(recipient_id, status);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at, status);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
 sender_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('text','file','audio')),
 ciphertext TEXT NOT NULL, iv TEXT NOT NULL, media_id TEXT,
 sent_at INTEGER NOT NULL, expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at);
CREATE TABLE IF NOT EXISTS media (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
 r2_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('file','audio')),
 size_bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_expiry ON media(expires_at);
CREATE TABLE IF NOT EXISTS payment_events (
 stripe_event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
 key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL
);
