// Storage. History that survives a restart.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

let db = null;

export function openDb(dir) {
  try {
    db = new DatabaseSync(path.join(dir, "vantage.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, in_bps REAL, out_bps REAL);
      CREATE TABLE IF NOT EXISTS latency (t INTEGER, target TEXT, ms REAL, PRIMARY KEY (t,target));
      CREATE TABLE IF NOT EXISTS devices (mac TEXT PRIMARY KEY, ip TEXT, name TEXT, vendor TEXT,
        kind TEXT, first_seen INTEGER, last_seen INTEGER, online INTEGER, rtt REAL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER,
        severity INTEGER, kind TEXT, message TEXT, acked INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS speedtests (t INTEGER PRIMARY KEY, down_mbps REAL,
        up_mbps REAL, latency_ms REAL);
      CREATE INDEX IF NOT EXISTS idx_samples_t ON samples(t);
      CREATE INDEX IF NOT EXISTS idx_latency_t ON latency(target,t);
      CREATE INDEX IF NOT EXISTS idx_events_t ON events(t);
    `);
    return true;
  } catch (err) {
    console.warn("  sqlite unavailable, running in memory:", err.message);
    db = null;
    return false;
  }
}

export const hasDb = () => !!db;

/* ---------------------------------------------------------------- samples */

export function saveSample(t, inBps, outBps) {
  if (!db) return;
  try {
    db.prepare("INSERT OR REPLACE INTO samples (t,in_bps,out_bps) VALUES (?,?,?)")
      .run(t, inBps || 0, outBps || 0);
  } catch {}
}

export function recentSamples(minutes = 30) {
  if (!db) return [];
  try {
    return db.prepare("SELECT t,in_bps,out_bps FROM samples WHERE t > ? ORDER BY t")
      .all(Date.now() - minutes * 60000);
  } catch { return []; }
}

// Hour by hour, for the calendar heatmap: one row per hour of the last N days.
export function hourlyTotals(days = 14) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT (t / 3600000) * 3600000 AS hour,
             SUM(in_bps + out_bps) / 60.0 AS bytes
        FROM samples
       WHERE t > ?
       GROUP BY hour
       ORDER BY hour`).all(Date.now() - days * 86400000);
  } catch { return []; }
}

/* ---------------------------------------------------------------- latency */

export function saveLatency(t, target, ms) {
  if (!db || ms == null) return;
  try {
    db.prepare("INSERT OR REPLACE INTO latency (t,target,ms) VALUES (?,?,?)")
      .run(t, target, ms);
  } catch {}
}

export function latencySeries(minutes = 60) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT target, (t / 60000) * 60000 AS minute, AVG(ms) AS ms, MAX(ms) AS worst
        FROM latency WHERE t > ?
       GROUP BY target, minute ORDER BY minute`)
      .all(Date.now() - minutes * 60000);
  } catch { return []; }
}

/* ----------------------------------------------------------------- devices */

export function saveDevice(d) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO devices (mac,ip,name,vendor,kind,first_seen,last_seen,online,rtt)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mac) DO UPDATE SET
        ip=excluded.ip, name=excluded.name, vendor=excluded.vendor,
        kind=excluded.kind, last_seen=excluded.last_seen,
        online=excluded.online, rtt=excluded.rtt`)
      .run(d.mac, d.ip, d.name || null, d.vendor || null, d.kind || null,
        d.firstSeen || Date.now(), Date.now(), d.online ? 1 : 0, d.rttMs ?? null);
  } catch {}
}

export function knownDevices() {
  if (!db) return [];
  try { return db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all(); }
  catch { return []; }
}

/* ------------------------------------------------------------------ events */

export function saveEvent(e) {
  if (!db) return null;
  try {
    const r = db.prepare(
      "INSERT INTO events (t,severity,kind,message,acked) VALUES (?,?,?,?,0)")
      .run(e.t, e.severity, e.kind, e.message);
    return Number(r.lastInsertRowid);
  } catch { return null; }
}

export function recentEvents(limit = 50) {
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT id,t,severity,kind,message,acked FROM events ORDER BY t DESC LIMIT ?")
      .all(limit);
  } catch { return []; }
}

export function ackEvent(id) {
  if (!db) return;
  try { db.prepare("UPDATE events SET acked=1 WHERE id=?").run(id); } catch {}
}

/* --------------------------------------------------------------- speedtests */

export function saveSpeedtest(t, downMbps, upMbps, latencyMs) {
  if (!db) return;
  try {
    db.prepare("INSERT OR REPLACE INTO speedtests (t,down_mbps,up_mbps,latency_ms) VALUES (?,?,?,?)")
      .run(t, downMbps, upMbps, latencyMs);
  } catch {}
}

export function speedHistory(days = 30) {
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM speedtests WHERE t > ? ORDER BY t DESC")
      .all(Date.now() - days * 86400000);
  } catch { return []; }
}

/* --------------------------------------------------------------- retention */

export function prune(days = 30) {
  if (!db) return;
  const cut = Date.now() - days * 86400000;
  try {
    db.exec(`DELETE FROM samples WHERE t < ${cut};
             DELETE FROM latency WHERE t < ${Date.now() - 7 * 86400000};
             DELETE FROM events WHERE t < ${cut};`);
  } catch {}
}
