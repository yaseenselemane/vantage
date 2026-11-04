// Latency, wake-on-LAN, speed test, fingerprints, connections, toasts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dgram from "node:dgram";
import net from "node:net";

const exec = promisify(execFile);

/* ---------------------------------------------------------------- ping/RTT */

export function pingOnce(ip, timeoutMs = 900) {
  return exec("ping.exe", ["-n", "1", "-w", String(timeoutMs), ip], {
    timeout: timeoutMs + 1200,
    windowsHide: true,
  })
    .then(({ stdout }) => {
      const m = /\btime[=<]\s*(\d+)\s*ms/i.exec(stdout);
      let ms = m ? Number(m[1]) : null;
      if (ms === null && /[<]\s*1\s*ms/i.test(stdout)) ms = 0.4;
      return { online: true, ms };
    })
    .catch(() => ({ online: false, ms: null }));
}

/* ------------------------------------------------------------- wake-on-LAN */

// Magic packet: 6 bytes of 0xFF, then the MAC 16 times, broadcast to UDP 9.
export function wake(mac) {
  const clean = (mac || "").replace(/[^0-9A-Fa-f]/g, "");
  if (clean.length !== 12) return Promise.reject(new Error("bad mac address"));

  const target = Buffer.from(clean, "hex");
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) target.copy(packet, 6 + i * 6);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, 9, "255.255.255.255", (err) => {
        socket.close();
        err ? reject(err) : resolve(true);
      });
    });
  });
}

/* ------------------------------------------------------- port fingerprinting */

// A handful of ports is enough to tell a printer from a TV from a NAS.
// Full scans are rude; this is a 400ms handshake and back off.
const PORTS = [
  { port: 80, kind: "web" },
  { port: 443, kind: "web" },
  { port: 22, kind: "ssh" },
  { port: 445, kind: "nas" },
  { port: 548, kind: "nas" },
  { port: 9100, kind: "printer" },
  { port: 631, kind: "printer" },
  { port: 554, kind: "camera" },
  { port: 8009, kind: "tv" },
  { port: 62078, kind: "phone" },
  { port: 32400, kind: "media" },
  { port: 53, kind: "router" },
  { port: 7547, kind: "router" },
];

function tryPort(ip, port, timeout = 420) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

// Probe every known port at once, then keep only the answers.
export async function fingerprint(ip) {
  const results = await Promise.all(PORTS.map((p) => tryPort(ip, p.port)));
  const open = [];
  const kinds = new Set();

  results.forEach((ok, i) => {
    if (!ok) return;
    open.push(PORTS[i].port);
    kinds.add(PORTS[i].kind);
  });

  // Order matters: a printer that also answers web is still a printer.
  const priority = ["printer", "camera", "router", "nas", "media", "tv", "phone", "ssh", "web"];
  const kind = priority.find((k) => kinds.has(k)) || null;

  return { open, kind };
}

/* --------------------------------------------------------- live connections */

// What this PC is talking to right now, and which app owns each socket.
export async function connections() {
  try {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='SilentlyContinue';
         $p = @{};
         Get-Process | ForEach-Object { $p[$_.Id] = $_.ProcessName };
         $c = Get-NetTCPConnection -State Established |
           Select-Object LocalPort,RemoteAddress,RemotePort,OwningProcess,
             @{n='Proc';e={ $p[[int]$_.OwningProcess] }};
         ConvertTo-Json -InputObject @($c) -Compress -Depth 3`,
      ],
      { timeout: 12000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout.trim() || "[]");
    const list = Array.isArray(rows) ? rows : [rows];
    return list
      .filter((r) => r.RemoteAddress && !/^(127\.|0\.0\.0\.0|::)/.test(r.RemoteAddress))
      .map((r) => ({
        localPort: r.LocalPort,
        remote: r.RemoteAddress,
        remotePort: r.RemotePort,
        pid: r.OwningProcess,
        process: r.Proc || null,
      }));
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- speed test */

// Cloudflare's public endpoints. 25 MB down, 10 MB up — enough to saturate
// most home links without hammering the connection for a minute.
const DOWN_URL = "https://speed.cloudflare.com/__down?bytes=25000000";
const UP_URL = "https://speed.cloudflare.com/__up";

export async function speedTest() {
  const result = { downMbps: null, upMbps: null, latencyMs: null, at: Date.now() };

  try {
    const t0 = Date.now();
    const res = await fetch(DOWN_URL, { cache: "no-store" });
    const buf = await res.arrayBuffer();
    const secs = (Date.now() - t0) / 1000;
    if (secs > 0) result.downMbps = (buf.byteLength * 8) / secs / 1e6;
  } catch {}

  try {
    const payload = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const t0 = Date.now();
    await fetch(UP_URL, { method: "POST", body: payload, cache: "no-store" });
    const secs = (Date.now() - t0) / 1000;
    if (secs > 0) result.upMbps = (payload.length * 8) / secs / 1e6;
  } catch {}

  const p = await pingOnce("1.1.1.1", 1500);
  result.latencyMs = p.ms;

  return result;
}

/* --------------------------------------------------------------- toast popup */

// Windows 10/11 toast, no extra modules. If notifications are muted or the
// build is old, this fails quietly — a missing popup never breaks the agent.
export function toast(title, body) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName("text")
$n.Item(0).AppendChild($t.CreateTextNode("${title.replace(/"/g, "'")}")) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode("${body.replace(/"/g, "'")}")) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("vantage").Show($toast)
`;
  exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 8000,
    windowsHide: true,
  }).catch(() => {});
}
