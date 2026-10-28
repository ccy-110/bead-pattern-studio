import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * SQLite。用 Node 24 内置的 `node:sqlite` —— 没有原生模块要编译，
 * 也没有数据库要装，备份就是把 `data/app.db` 拷走。
 *
 * 注意它在 Node 24 里仍标注为实验特性，启动时可能打印
 * `ExperimentalWarning: SQLite is an experimental feature`。
 * 功能是完整的；万一将来 API 有变，只有这个文件需要改。
 */
export type Db = DatabaseSync

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)

  // WAL：读写不互相阻塞；busy_timeout 让并发写等待而不是立刻报错
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)

  migrate(db)
  return db
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS patterns (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      rows         INTEGER NOT NULL,
      cols         INTEGER NOT NULL,
      palette_id   TEXT,
      bead_size_mm REAL NOT NULL,
      -- 完整的 PatternFile JSON。图纸文件本来就是自包含、带版本号的，
      -- 原样存下来最稳：将来格式升级也能照原样取回。
      data         TEXT NOT NULL,
      thumbnail    TEXT,
      -- 分享用不可猜的随机串，不用自增 ID：否则别人的图纸能被挨个翻出来
      share_slug   TEXT UNIQUE,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_user ON patterns(user_id, updated_at DESC);
  `)
}

/** 清理过期会话。启动时跑一次，之后每次登录顺带跑一次即可。 */
export function deleteExpiredSessions(db: Db, now = Date.now()): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  return Number(result.changes)
}
