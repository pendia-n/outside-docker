"""Exercise actual migrations and reward SQL against SQLite with foreign keys."""
import re
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
db.executescript('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE rooms(id TEXT PRIMARY KEY);')
db.executescript((root / 'migrations/0002_full_room_rewards.sql').read_text())
db.execute("INSERT INTO users VALUES('u')")
for n in range(1, 4):
    db.execute('INSERT INTO rooms VALUES(?)', (str(n),))
    db.execute('INSERT INTO paid_room_purchases VALUES(?,?,?)', (str(n), 'u', n * 1000))
db.execute("INSERT INTO paid_room_rewards VALUES('3','u',3000,8)")
db.execute("INSERT INTO full_room_credit_balances VALUES('u',7,3000)")
db.executescript((root / 'migrations/0003_preserve_reward_history.sql').read_text())
db.execute('DELETE FROM rooms')
assert db.execute('SELECT COUNT(*) FROM paid_room_purchases').fetchone()[0] == 3
assert db.execute('SELECT COUNT(*) FROM paid_room_rewards').fetchone()[0] == 1
assert db.execute('SELECT credits FROM full_room_credit_balances').fetchone()[0] == 7
source = (root / 'src/lib/api.ts').read_text()
reward_sql = re.search(r'`(INSERT OR IGNORE INTO paid_room_rewards.*?)`', source, re.S).group(1)
window = 5 * 24 * 3600 * 1000
for n in range(4, 7):
    now = n * 1000
    db.execute('INSERT INTO paid_room_purchases VALUES(?,?,?)', (str(n), 'u', now))
    db.execute(reward_sql, (str(n), 'u', now, 'u', now-window, 'u'))
    assert db.execute('SELECT COUNT(*) FROM paid_room_rewards').fetchone()[0] == (2 if n == 6 else 1)
# Replayed qualification cannot grant the same reward twice.
db.execute(reward_sql, ('6', 'u', 6000, 'u', 6000-window, 'u'))
assert db.execute('SELECT COUNT(*) FROM paid_room_rewards').fetchone()[0] == 2
# Three new payments outside a rolling five-day window must not qualify.
for n in range(7, 10):
    now = n * window
    db.execute('INSERT INTO paid_room_purchases VALUES(?,?,?)', (str(n), 'u', now))
    db.execute(reward_sql, (str(n), 'u', now, 'u', now-window, 'u'))
assert db.execute('SELECT COUNT(*) FROM paid_room_rewards').fetchone()[0] == 2
assert not db.execute('PRAGMA foreign_key_check').fetchall()
print('PASS: room deletion preserves payments, rewards and credit balance; repeat rewards require three fresh payments in five days.')
