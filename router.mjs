// Whole-house data usage. The router tracks it for the SIM; we just ask.
// Two quirks: every endpoint needs ?flag=<name>&t=<ms>, and the password is
// hashed as sha256(salt + ":" + password) with a 64-char random salt.

import { createHash, randomBytes } from "node:crypto";

const BASE = "http://192.168.0.1";

let session = null; // { token, cookie, at }

export async function login(username, password) {
  const salt = randomBytes(48).toString("base64url").slice(0, 64);
  const digest = createHash("sha256").update(`${salt}:${password}`).digest("hex");

  const res = await fetch(
    `${BASE}/cgi-bin/luci/login/action_login?flag=action_login&t=${Date.now()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: BASE + "/",
        Origin: BASE,
      },
      body: JSON.stringify({ username, password: digest, salt }),
      signal: AbortSignal.timeout(8000),
    },
  );

  const body = await res.json();
  if (body.code !== 0 || !body.token) {
    throw new Error(`login failed: ${body.msg || res.status}`);
  }

  const setCookie = res.headers.getSetCookie?.() || [];
  const sysauth = (setCookie.map((c) => c.split(";")[0]).join("; ") || "");
  const sid = body.sessionid || (/sysauth_http=([^;]+)/.exec(sysauth) || [])[1] || "";

  // The ubus endpoint checks all four of these, not just the session id.
  const cookie = [
    `sysauth_http=${sid}`,
    `username=${username}`,
    `token=${body.token}`,
    `roles=admin`,
  ].join("; ");

  // The ubus session token is the session id from the login reply, not the
  // separate "token" field. They look alike but only one is accepted.
  session = {
    token: body.sessionid || body.token,
    cookie,
    at: Date.now(),
  };
  return session;
}

export async function call(object, method, params = {}) {
  return ubus(object, method, params);
}

// Method signatures for objects matching a pattern ("hw.qos", "net.*").
// The ACL shows "*" for some objects, so this is the only way to see their methods.
export async function list(pattern) {
  if (!session) throw new Error("not logged in");
  const res = await fetch(`${BASE}/ubus/?flag=list&t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Referer: BASE + "/", Cookie: session.cookie },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "list", params: [pattern] }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result ?? null;
}

async function ubus(object, method, params = {}) {
  if (!session) throw new Error("not logged in");

  const res = await fetch(`${BASE}/ubus/?flag=${method}&t=${Date.now()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      Referer: BASE + "/",
      Cookie: session.cookie,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: [session.token, object, method, params],
    }),
    signal: AbortSignal.timeout(8000),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result?.[1] ?? null;
}

const bytes = (v) => {
  if (v == null) return 0;
  const m = /(\d+)/.exec(String(v));
  return m ? Number(m[1]) : 0;
};

// "12.3 Kbps" → 12300. The router formats its own rates as text.
const UNIT = { bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9 };
const rate = (v) => {
  const m = /([\d.]+)\s*([kmg]?bps)/i.exec(String(v ?? ""));
  return m ? parseFloat(m[1]) * UNIT[m[2].toLowerCase()] : 0;
};

/**
 * Every device the router has online, with its live upload/download rate.
 * get_ip_list gives names; get_mac_rate gives rates the router already
 * computed. hnat (hardware offload) and snat (software NAT) are separate
 * paths, so a device's total is the sum of both, v4 and v6.
 */
export async function clients() {
  const list = await ubus("net.info", "get_ip_list");
  const online = Object.values(list?.Online || {}).flat();
  return Promise.all(online.map(async (c) => {
    const r = await ubus("net.info", "get_mac_rate", { object: c.MAC, detail: true }).catch(() => null);
    let upBps = 0, downBps = 0;
    for (const path of ["hnat", "snat"]) {
      for (const v of ["v4", "v6"]) {
        upBps += rate(r?.[path]?.[v]?.upload);
        downBps += rate(r?.[path]?.[v]?.download);
      }
    }
    return {
      mac: String(c.MAC).toUpperCase(),
      ip: c.IP,
      name: c.NAME || null,
      upBps: r ? upBps : null,
      downBps: r ? downBps : null,
    };
  }));
}

export const _rate = rate; // for the self-check

/**
 * Returns what the router knows about the whole connection:
 * data used today, data used this month, signal, and radio type.
 */
export async function snapshot() {
  const [traffic, status] = await Promise.all([
    ubus("cell.traffic", "get_traffic_cfg"),
    ubus("jytl_api", "get_status_info").catch(() => null),
  ]);

  const stats = traffic?.stats || {};
  const info = status?.data || {};

  return {
    at: Date.now(),
    dayBytes: bytes(stats.day_traffic),
    monthBytes: bytes(stats.month_traffic),
    signal: info.SignalValue || null,
    radio: info.NR_or_LTE || info.SignalName || null,
    wanUp: String(info.wanstat || "").startsWith("true"),
    carrier: info.long_eons || null,
    clients: null,
  };
}
