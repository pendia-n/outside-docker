CREATE TABLE paid_room_purchases (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchased_at INTEGER NOT NULL
);
CREATE INDEX paid_room_purchases_user_time ON paid_room_purchases(user_id, purchased_at);

CREATE TABLE paid_room_rewards (
  trigger_room_id TEXT PRIMARY KEY REFERENCES paid_room_purchases(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  credits INTEGER NOT NULL CHECK (credits = 8)
);
CREATE INDEX paid_room_rewards_user_time ON paid_room_rewards(user_id, granted_at);

CREATE TABLE full_room_credit_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  updated_at INTEGER NOT NULL
);
