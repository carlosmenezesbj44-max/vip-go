import session from 'express-session';
import { database } from './db.js';

const Store = session.Store;
const getSession = database.prepare('SELECT session_json AS sessionJson, expires_at AS expiresAt FROM sessions WHERE sid = ?');
const saveSession = database.prepare(`INSERT INTO sessions (sid, expires_at, session_json) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, session_json = excluded.session_json`);
const removeSession = database.prepare('DELETE FROM sessions WHERE sid = ?');
const removeExpired = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');

export class SQLiteSessionStore extends Store {
  constructor({ ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => removeExpired.run(Date.now()), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = getSession.get(sid);
      if (!row) return callback(null, null);
      if (row.expiresAt <= Date.now()) {
        removeSession.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sessionJson));
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.ttlMs;
      saveSession.run(sid, expiresAt, JSON.stringify(value));
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.ttlMs;
      database.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { removeSession.run(sid); callback(null); }
    catch (error) { callback(error); }
  }

  close() { clearInterval(this.cleanupTimer); }
}
