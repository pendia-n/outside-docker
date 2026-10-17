-- Payment qualification must survive room expiry/deletion. Retain only payment
-- identifiers and reward accounting here, never chat content.
CREATE TABLE paid_room_purchases_v3 (
  room_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purchased_at INTEGER NOT NULL
);
INSERT INTO paid_room_purchases_v3 SELECT * FROM paid_room_purchases;

CREATE TABLE paid_room_rewards_v3 (
  trigger_room_id TEXT PRIMARY KEY REFERENCES paid_room_purchases_v3(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  credits INTEGER NOT NULL CHECK (credits = 8)
);
INSERT INTO paid_room_rewards_v3 SELECT * FROM paid_room_rewards;

DROP TABLE paid_room_rewards;
DROP TABLE paid_room_purchases;
ALTER TABLE paid_room_purchases_v3 RENAME TO paid_room_purchases;
ALTER TABLE paid_room_rewards_v3 RENAME TO paid_room_rewards;
CREATE INDEX paid_room_purchases_user_time ON paid_room_purchases(user_id, purchased_at);
CREATE INDEX paid_room_rewards_user_time ON paid_room_rewards(user_id, granted_at);
