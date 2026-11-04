// vantage agent — real network data from this PC.
// No switch needed. No database. No install.
// Run:  node agent.mjs   then open http://localhost:8123

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";
import path from "node:path";
import os from "node:os";
import * as store from "./db.mjs";
import { pingOnce, wake, fingerprint, connections, speedTest, toast } from "./tools.mjs";
import { get as snmpGet } from "./snmp.mjs";
import * as router from "./router.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8123);
const OPEN = process.env.VANTAGE_NO_BROWSER !== "1";

/* ═══════════════════════════════════════════════════════════════
   COLLECT
   ═══════════════════════════════════════════════════════════════ */

// One PowerShell call returns adapters, counters, neighbours and the raw
// netsh output. One process spawn per cycle instead of four — on Windows a
// spawn costs ~150ms and that is the whole polling budget.
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$adapters = @(Get-NetAdapter | Where-Object { $_.Status -ne 'Not Present' } | ForEach-Object {
  [pscustomobject]@{
    name   = $_.Name
    desc   = $_.InterfaceDescription
    status = [string]$_.Status
    link   = [string]$_.LinkSpeed
    mac    = [string]$_.MacAddress
    index  = [int]$_.ifIndex
  }
})
$stats = @(Get-NetAdapterStatistics | ForEach-Object {
  [pscustomobject]@{
    name  = $_.Name
    rx    = [double]$_.ReceivedBytes
    tx    = [double]$_.SentBytes
    rxErr = [int]$_.ReceivedPacketErrors
    txErr = [int]$_.OutboundPacketErrors
  }
})
$neighbors = @(Get-NetNeighbor -AddressFamily IPv4 | Where-Object {
  $_.LinkLayerAddress -and
  $_.IPAddress -notmatch '^(224|239|255|0)\\.' -and
  $_.State -ne 'Unreachable'
} | ForEach-Object {
  [pscustomobject]@{
    ip      = [string]$_.IPAddress
    mac     = [string]$_.LinkLayerAddress
    state   = [string]$_.State
    adapter = [string]$_.InterfaceAlias
  }
})
$wifi = (netsh wlan show interfaces 2>$null | Out-String)
[pscustomobject]@{
  adapters  = $adapters
  stats     = $stats
  neighbors = $neighbors
  wifi      = $wifi
} | ConvertTo-Json -Compress -Depth 5
`;

async function collectWindows() {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
    { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("PowerShell returned nothing");
  return JSON.parse(trimmed);
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// "1 Gbps" / "866.7 Mbps" / "100 Mbps" → bits per second.
// This is the number the OS reports for the link, not a guess.
function parseLinkSpeed(text) {
  if (!text) return 0;
  const m = /([\d.]+)\s*([A-Za-z]+)/.exec(String(text));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("tb")) return n * 1e12;
  if (unit.startsWith("gb")) return n * 1e9;
  if (unit.startsWith("mb")) return n * 1e6;
  if (unit.startsWith("kb")) return n * 1e3;
  return n;
}

// netsh output is "Key : value" per line. On non-English Windows the keys
// differ, so we also look at value shapes (a bare percentage = signal).
function parseWifi(raw) {
  const out = { connected: false };
  if (!raw) return out;

  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z0-9 ()#.\/_-]*?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) map[m[1].trim()] = m[2].trim();
  }

  const state = map["State"] || map["Status"] || "";
  out.connected = /connected/i.test(state);
  out.ssid = map["SSID"] || null;
  out.bssid = map["BSSID"] || null;
  out.radio = map["Radio type"] || null;
  out.channel = map["Channel"] || null;

  let signal = parseInt(String(map["Signal"] || "").replace("%", ""), 10);
  if (!Number.isFinite(signal)) {
    for (const v of Object.values(map)) {
      const p = /^(\d{1,3})%$/.exec(v);
      if (p) { signal = parseInt(p[1], 10); break; }
    }
  }
  out.signal = Number.isFinite(signal) ? signal : null;

  const rx = parseFloat(map["Receive rate (Mbps)"] || "");
  const tx = parseFloat(map["Transmit rate (Mbps)"] || "");
  out.rxMbps = Number.isFinite(rx) ? rx : null;
  out.txMbps = Number.isFinite(tx) ? tx : null;

  return out;
}

/* ═══════════════════════════════════════════════════════════════
   VENDOR LOOKUP  (first 3 bytes of the MAC)
   ═══════════════════════════════════════════════════════════════ */

const OUI = {
  "001A11": "Google", "001B63": "Apple", "001E52": "Apple", "001F5B": "Apple",
  "00226B": "Cisco-Linksys", "0024B2": "Netgear", "0026F2": "Netgear",
  "000C29": "VMware", "005056": "VMware", "080027": "VirtualBox",
  "001132": "Synology", "0011D8": "Asus", "001731": "Asus", "04D4C4": "Asus",
  "001839": "Cisco", "000F23": "Cisco", "00170F": "Cisco", "002699": "Cisco",
  "001DD3": "Apple", "002608": "Apple", "003EE1": "Apple", "0050E4": "Apple",
  "3C0754": "Apple", "5C969D": "Apple", "7CD1C3": "Apple", "8C8590": "Apple",
  "A45E60": "Apple", "D0E140": "Apple", "F0DBF8": "Apple", "ACBC32": "Apple",
  "0018DD": "Samsung", "002454": "Samsung", "002637": "Samsung",
  "34AA8B": "Samsung", "5CA39D": "Samsung", "8C71F8": "Samsung",
  "001DBA": "Sony", "0019C5": "Sony", "0024BE": "Sony",
  "001A79": "TP-Link", "14CC20": "TP-Link", "1CFA68": "TP-Link",
  "50C7BF": "TP-Link", "A42BB0": "TP-Link", "B0BE76": "TP-Link",
  "001E58": "D-Link", "001CF0": "D-Link", "1CBDB9": "D-Link",
  "00248C": "Asus", "04E676": "Asus", "2CAE2B": "Samsung",
  "0017C9": "Samsung", "0090A9": "Western Digital", "0004ED": "Billion",
  "00E04C": "Realtek", "52540A": "QEMU", "00155D": "Hyper-V",
  "DC4A9E": "Shenzhen", "F4F26D": "TP-Link", "E8DE27": "TP-Link",
  "0009B0": "Onkyo", "001AF0": "Ruckus", "C0C9E3": "Ruckus",
  "0026B9": "Dell", "00188B": "Dell", "F8B156": "Dell",
  "001B21": "Intel", "001E64": "Intel", "3C970E": "Intel",
  "8086F2": "Intel", "A4C494": "Intel", "E4A471": "Intel",
  "001CC4": "HP", "0025B3": "HP", "3C4A92": "HP", "941882": "HP",
  "0016E6": "Raspberry Pi", "B827EB": "Raspberry Pi", "DCA632": "Raspberry Pi",
  "E45F01": "Raspberry Pi", "2CCF67": "Raspberry Pi",
  "001DD8": "Microsoft", "0017FA": "Microsoft", "7C1E52": "Microsoft",
  "00D0B7": "Intel", "001550": "Nokia", "001A8C": "Sony",
};

function vendorFor(mac) {
  if (!mac) return null;
  const key = mac.replace(/[^0-9A-Fa-f]/g, "").slice(0, 6).toUpperCase();
  return OUI[key] || null;
}

/* ═══════════════════════════════════════════════════════════════
   PING  (real reachability, limited concurrency)
   ═══════════════════════════════════════════════════════════════ */

async function pingHost(ip) {
  const started = Date.now();
  try {
    const { stdout } = await exec("ping.exe", ["-n", "1", "-w", "900", ip], {
      timeout: 2000,
      windowsHide: true,
    });
    const m = /\btime[=<]\s*(\d+)\s*ms/i.exec(stdout);
    let rtt = m ? parseFloat(m[1]) : null;
    if (!m && /[<]\s*1\s*ms/i.test(stdout)) rtt = 0.5;
    return { online: true, rttMs: rtt ?? Math.max(1, Date.now() - started) };
  } catch {
    return { online: false, rttMs: null };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function reverseName(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 600)),
    ]);
    return names?.[0] ?? null;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */

const state = {
  prev: new Map(),          // adapter name -> { rx, tx, at }
  pingCache: new Map(),     // ip -> { online, rttMs, name }
  clients: new Map(),       // mac -> router's view { ip, name, upBps, downBps }
  lastProbeAt: 0,
  links: [],
  wifi: { connected: false },
  devices: [],
  events: [],
  series: [],               // { t, in, out }
  lastCollect: 0,
  error: null,
};

let eventId = 1;
function pushEvent(severity, kind, message) {
  const now = Date.now();
  const recent = state.events.find(
    (e) => e.kind === kind && e.message === message && now - e.at < 120_000,
  );
  if (recent) return;
  const id = store.saveEvent({ t: now, severity, kind, message }) || eventId++;
  state.events.unshift({ id, severity, kind, message, at: now, acked: false });
  state.events = state.events.slice(0, 60);
  if (severity >= 2) toast("vantage", message);
}

function localInterfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal);
}

const localIPs = () => new Set(localInterfaces().map((i) => i.address));

// A MAC is only useful if it belongs to one real device. Broadcast, multicast
// and all-zero addresses are group identifiers, not hosts.
function isRealMac(mac) {
  if (!mac) return false;
  const clean = mac.replace(/[^0-9A-Fa-f]/g, "");
  if (clean.length !== 12) return false;
  if (/^0+$/.test(clean) || /^F+$/i.test(clean)) return false;
  const firstOctet = parseInt(clean.slice(0, 2), 16);
  return (firstOctet & 1) === 0; // multicast bit set means a group, skip it
}

// .0 and .255 in a /24 are network and broadcast, never a host.
function isHostAddress(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return false;
  if (parts[0] === 127) return false;
  if (parts[0] === 224 || parts[0] >= 240) return false;
  const last = parts[3];
  return last !== 0 && last !== 255;
}

// Ping the broadcast address of every local /24. Every awake device on the
// segment answers, which fills the ARP table in one shot. This is how you find
// devices that your PC has never had a reason to talk to.
async function sweepSubnets() {
  const nets = new Set();
  for (const i of localInterfaces()) {
    const parts = i.address.split(".");
    if (parts.length === 4) nets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
  }
  await Promise.all(
    [...nets].map((b) =>
      exec("ping.exe", ["-n", "1", "-w", "400", b], {
        timeout: 1200,
        windowsHide: true,
      }).catch(() => {}),
    ),
  );
}

/* ═══════════════════════════════════════════════════════════════
   ONE COLLECTION CYCLE
   ═══════════════════════════════════════════════════════════════ */

async function collect() {
  const now = Date.now();

  let raw;
  try {
    raw = await collectWindows();
    state.error = null;
  } catch (err) {
    state.error = String(err.message || err);
    return;
  }

  const adapters = asArray(raw.adapters);
  const stats = asArray(raw.stats);
  const neighbours = asArray(raw.neighbors);

  const statByName = new Map(stats.map((s) => [s.name, s]));

  /* ---- links + real rates ---- */
  state.links = adapters.map((a) => {
    const s = statByName.get(a.name) || { rx: 0, tx: 0, rxErr: 0, txErr: 0 };
    const speed = parseLinkSpeed(a.link);
    const prev = state.prev.get(a.name);

    let inBps = null;
    let outBps = null;
    let utilPct = null;

    if (prev) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.2) {
        // A counter that went backwards means the adapter reset. Do not invent
        // a rate from it — wait for the next clean pair.
        if (s.rx >= prev.rx && s.tx >= prev.tx) {
          inBps = ((s.rx - prev.rx) * 8) / dt;
          outBps = ((s.tx - prev.tx) * 8) / dt;
          if (speed > 0) {
            utilPct = (Math.max(inBps, outBps) / speed) * 100;
          }
        }
      }
    }

    state.prev.set(a.name, { rx: s.rx, tx: s.tx, at: now });

    return {
      name: a.name,
      desc: a.desc,
      status: a.status,
      up: /up/i.test(a.status),
      speedBps: speed,
      mac: a.mac,
      inBps,
      outBps,
      utilPct,
      rxErrors: s.rxErr,
      txErrors: s.txErr,
    };
  });

  /* ---- wifi ---- */
  state.wifi = parseWifi(raw.wifi);

  /* ---- devices on the LAN ---- */
  //
  // Two speeds of work happen here. Reading the neighbour table is free and
  // runs every cycle. Pinging 20 hosts is not — that runs on its own 15s
  // timer and the results are cached in between, so the chart never stutters
  // waiting for a dead phone to time out.
  const mine = localIPs();
  const seen = new Map();

  for (const n of neighbours) {
    if (!n.ip || !isHostAddress(n.ip)) continue;
    if (!isRealMac(n.mac)) continue;
    if (seen.has(n.ip)) continue;
    seen.set(n.ip, {
      ip: n.ip,
      mac: n.mac.toUpperCase().replace(/-/g, ":"),
      state: n.state,
      adapter: n.adapter,
      self: mine.has(n.ip),
    });
  }

  // Always include this PC even when it has no ARP entry of its own.
  for (const i of localInterfaces()) {
    if (seen.has(i.address)) continue;
    if (!isRealMac(i.mac)) continue;
    seen.set(i.address, {
      ip: i.address,
      mac: i.mac.toUpperCase().replace(/-/g, ":"),
      state: "Reachable",
      adapter: i.name,
      self: true,
    });
  }

  // Devices the router has online but ARP has not seen — asleep phones, or
  // the far side of the mesh extender.
  for (const c of state.clients.values()) {
    if (seen.has(c.ip) || !isHostAddress(c.ip)) continue;
    seen.set(c.ip, { ip: c.ip, mac: c.mac, state: "Router", adapter: null, self: false });
  }

  const list = [...seen.values()].slice(0, 64).sort((a, b) => (a.self ? -1 : b.self ? 1 : 0));

  const nowPing = Date.now();
  const needsProbe = nowPing - (state.lastProbeAt || 0) > 15_000;

  if (needsProbe) {
    await sweepSubnets();
    state.lastProbeAt = nowPing;
  }

  const probed = await mapLimit(list, 12, async (d) => {
    const cached = state.pingCache.get(d.ip);

    // Self is always online — we are running on it.
    if (d.self) {
      const name = os.hostname();
      state.pingCache.set(d.ip, { online: true, rttMs: 0, name });
      return { ...d, online: true, rttMs: 0, name, vendor: vendorFor(d.mac) || null };
    }

    if (!needsProbe && cached) {
      return { ...d, ...cached, vendor: vendorFor(d.mac) || null };
    }

    const r = await pingHost(d.ip);
    const name = r.online ? await reverseName(d.ip) : null;
    const result = { online: r.online, rttMs: r.rttMs, name };
    state.pingCache.set(d.ip, result);
    return { ...d, ...result, vendor: vendorFor(d.mac) || null };
  });

  // The router sees every device's traffic; this PC only sees its own. A phone
  // that ignores ping is still online if the router says so.
  state.devices = probed.map((d) => {
    const c = state.clients.get(d.mac);
    if (!c) return d;
    return { ...d, online: true, name: c.name || d.name, upBps: c.upBps, downBps: c.downBps };
  });

  /* ---- the system's own total ---- */
  const upLinks = state.links.filter((l) => l.up);
  const totalIn = upLinks.reduce((a, l) => a + (l.inBps || 0), 0);
  const totalOut = upLinks.reduce((a, l) => a + (l.outBps || 0), 0);

  state.series.push({ t: now, in: totalIn, out: totalOut });
  if (state.series.length > 180) state.series.shift();

  state.lastCollect = now;

  /* ---- persist this cycle ---- */
  store.saveSample(now, totalIn, totalOut);
  for (const d of state.devices) store.saveDevice(d);

  /* ---- events, from real conditions ---- */
  for (const l of state.links) {
    if (l.status && !/up/i.test(l.status) && !/disconnected/i.test(l.status)) {
      pushEvent(1, "link", `${l.name} is ${l.status.toLowerCase()}`);
    }
  }
  if (state.wifi.connected && state.wifi.signal != null && state.wifi.signal < 45) {
    pushEvent(1, "wifi", `WiFi signal is weak (${state.wifi.signal}%)`);
  }
  for (const l of state.links) {
    if (l.utilPct != null && l.utilPct > 85) {
      pushEvent(1, "traffic", `${l.name} is at ${Math.round(l.utilPct)}% of link speed`);
    }
  }
  for (const d of state.devices) {
    if (!d.online && !d.self) {
      pushEvent(2, "host", `${d.name || d.ip} is not answering`);
    }
  }

  // Drop "everything is down" noise on first run.
  if (state.events.length === 0) {
    pushEvent(0, "system", "Monitoring started on this PC");
  }
}

/* ═══════════════════════════════════════════════════════════════
   SNAPSHOT
   ═══════════════════════════════════════════════════════════════ */

function snapshot() {
  const upLinks = state.links.filter((l) => l.up);
  const totalIn = upLinks.reduce((a, l) => a + (l.inBps || 0), 0);
  const totalOut = upLinks.reduce((a, l) => a + (l.outBps || 0), 0);

  return {
    at: new Date().toISOString(),
    host: { name: os.hostname(), platform: `${os.type()} ${os.release()}` },
    error: state.error,
    wifi: state.wifi,
    links: state.links,
    totals: { inBps: totalIn, outBps: totalOut },
    wan: state.wan || null,
    router: state.router || null,
    devices: state.devices,
    events: state.events.filter((e) => !e.acked).slice(0, 30),
    series: state.series,
    stats: {
      linksUp: upLinks.length,
      linksTotal: state.links.length,
      devicesOnline: state.devices.filter((d) => d.online).length,
      devicesTotal: state.devices.length,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
   HTTP
   ═══════════════════════════════════════════════════════════════ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/api/v1/snapshot") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === "/api/v1/history") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      hourly: store.hourlyTotals(14),
      latency: store.latencySeries(180),
      speed: store.speedHistory(30),
    }));
    return;
  }

  if (url.pathname === "/api/v1/connections") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ connections: await connections() }));
    return;
  }

  if (url.pathname === "/api/v1/speedtest" && req.method === "POST") {
    const r = await speedTest();
    store.saveSpeedtest(r.at, r.downMbps, r.upMbps, r.latencyMs);
    pushEvent(0, "speed", `Speed test: ${r.downMbps?.toFixed(0) ?? "?"} down / ${r.upMbps?.toFixed(0) ?? "?"} up Mbps`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(r));
    return;
  }

  if (url.pathname === "/api/v1/wake" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { mac } = JSON.parse(body || "{}");
        await wake(mac);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/v1/fingerprint" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { ip } = JSON.parse(body || "{}");
        const fp = await fingerprint(ip);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(fp));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/v1/collect" && req.method === "POST") {
    await collect();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/api/v1/ack" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        const e = state.events.find((x) => x.id === id);
        if (e) e.acked = true;
        store.ackEvent(id);
      } catch {}
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Serve the dashboard itself so everything is one origin.
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const data = await readFile(path.join(HERE, "public", file));
    const type = file.endsWith(".html")
      ? "text/html; charset=utf-8"
      : file.endsWith(".css")
        ? "text/css; charset=utf-8"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-cache");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */

const url = `http://localhost:${PORT}`;

console.log("");
console.log("  vantage agent");
console.log("  ─────────────────────────────────");
console.log(`  reading real data from: ${os.hostname()}`);
console.log(`  open: ${url}`);
console.log("  stop: Ctrl+C");
console.log("");

await collect().catch((e) => console.error("first collect failed:", e.message));

/* open the database first so every cycle has somewhere to write */
store.openDb(HERE);
store.prune(30);

/* continuous latency watch — router and the public internet */
const latencyTargets = ["1.1.1.1", "8.8.8.8"];

setInterval(async () => {
  for (const target of latencyTargets) {
    const r = await pingOnce(target, 1500);
    store.saveLatency(Date.now(), target, r.ms);
  }
  const router = state.devices.find((d) => /\.1$/.test(d.ip) && !d.self);
  if (router) {
    const r = await pingOnce(router.ip, 1200);
    store.saveLatency(Date.now(), "router", r.ms);
  }
}, 5000);

/* whole-house data usage, straight from the router */
const ROUTER_USER = process.env.VANTAGE_ROUTER_USER || "admin";
const ROUTER_PASS = process.env.VANTAGE_ROUTER_PASS || "";
let routerReady = false;

setInterval(async () => {
  try {
    if (!ROUTER_PASS) return;
    if (!routerReady) {
      await router.login(ROUTER_USER, ROUTER_PASS);
      routerReady = true;
    }
    const snap = await router.snapshot();
    const prev = state.router;
    if (prev && snap.monthBytes >= prev.monthBytes) {
      const dt = (snap.at - prev.at) / 1000;
      snap.rxBps = ((snap.monthBytes - prev.monthBytes) * 8) / dt;
    }
    state.router = snap;
  } catch (err) {
    routerReady = false;
    state.router = state.router || { error: String(err.message || err) };
  }
}, 30000);

/* live per-device rates, straight from the router */
setInterval(async () => {
  if (!routerReady) return;
  try {
    const list = await router.clients();
    state.clients = new Map(list.map((c) => [c.mac, c]));
  } catch {
    routerReady = false;
    state.clients = new Map(); // stale rates are worse than none
  }
}, 5000);

/* ask the router for whole-house counters, if it speaks SNMP */
setInterval(async () => {
  const gateway = state.devices.find((d) => /\.1$/.test(d.ip) && !d.self)?.ip;
  if (!gateway) return;

  const community = process.env.VANTAGE_SNMP_COMMUNITY || "public";
  const inOct = await snmpGet(gateway, community, "1.3.6.1.2.1.31.1.1.1.6.2", 1200);
  const outOct = await snmpGet(gateway, community, "1.3.6.1.2.1.31.1.1.1.7.2", 1200);

  if (inOct && outOct && (inOct.value || outOct.value)) {
    const prev = state.wan;
    state.wan = {
      at: Date.now(),
      rxBytes: inOct.value,
      txBytes: outOct.value,
      source: "snmp",
      router: gateway,
    };
    if (prev && inOct.value >= prev.rxBytes && outOct.value >= prev.txBytes) {
      const dt = (Date.now() - prev.at) / 1000;
      state.wan.rxBps = ((inOct.value - prev.rxBytes) * 8) / dt;
      state.wan.txBps = ((outOct.value - prev.txBytes) * 8) / dt;
    }
  } else if (!state.wan) {
    state.wan = { at: Date.now(), available: false, router: gateway };
  }
}, 15000);

/* fingerprint one unknown device at a time — slow on purpose, it is a scan */setInterval(async () => {
  const target = state.devices.find((d) => !d.self && !d.kind);
  if (!target) return;
  try {
    const fp = await fingerprint(target.ip);
    target.kind = fp.kind;
    target.ports = fp.open;
    store.saveDevice(target);
  } catch {}
}, 4000);

/* search of new devices, slower than the counters */
setInterval(() => {
  collect().catch((e) => { state.error = String(e.message || e); });
}, 3000);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`  listening on ${url}`);
  console.log("");
  if (OPEN) {
    exec("cmd", ["/c", "start", "", url]).catch(() => {});
  }
});
