// One-off probe: which per-device calls will the router answer for this login?
// Read-only — it only calls info/list/get methods.
// Run:  $env:VANTAGE_ROUTER_PASS = "..." ; node probe-router.mjs
// Full replies land in router-probe.json (gitignored, it holds MACs and IPs).

import { writeFile } from "node:fs/promises";
import * as router from "./router.mjs";

const pass = process.env.VANTAGE_ROUTER_PASS;
if (!pass) {
  console.error("Set VANTAGE_ROUTER_PASS first.");
  process.exit(1);
}
await router.login(process.env.VANTAGE_ROUTER_USER || "admin", pass);
console.log("logged in\n");

const results = {};

function preview(r) {
  if (Array.isArray(r)) return `${r.length} items`;
  if (r && typeof r === "object") {
    const keys = Object.keys(r);
    const list = Array.isArray(r.results) ? ` (results: ${r.results.length})` : "";
    return `keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}${list}`;
  }
  return String(r);
}

// router.call returns null when ubus answers with a non-zero status
// (denied / not found), so null counts as "no".
async function probe(object, method, params = {}) {
  const key = `${object}.${method}${Object.keys(params).length ? " " + JSON.stringify(params) : ""}`;
  try {
    const r = await router.call(object, method, params);
    results[key] = r;
    console.log(`  ${r == null ? "no " : "YES"}  ${key}${r == null ? "" : "  " + preview(r)}`);
    return r;
  } catch (e) {
    results[key] = { error: String(e.message || e) };
    console.log(`  no   ${key}  (${e.message})`);
    return null;
  }
}

// 1. What does the ACL say we may call?
console.log("ACL");
const acl = await probe("session", "access");
const allowed = acl?.ubus || {};
for (const [obj, methods] of Object.entries(allowed)) {
  console.log(`       ${obj}: ${[].concat(methods).join(", ")}`);
}

// 2. WiFi clients — per-station bytes, signal, rates.
console.log("\nWiFi clients");
const devs = await probe("iwinfo", "devices");
const radios = devs?.devices?.length
  ? devs.devices
  : ["wlan0", "wlan1", "ra0", "rai0", "rax0", "phy0-ap0", "phy1-ap0"];
for (const device of radios) {
  await probe("iwinfo", "assoclist", { device });
}

// 3. Names and leases.
console.log("\nNames / leases");
await probe("luci-rpc", "getDHCPLeases");
await probe("luci-rpc", "getHostHints");
await probe("luci-rpc", "getWirelessDevices");
await probe("network.interface", "dump");

// 4. Anything else the ACL lists that sounds like a device list — get-style only.
console.log("\nVendor calls from ACL");
const looksUseful = /client|device|host|sta|lan|user|station|traffic|assoc/i;
for (const [obj, methods] of Object.entries(allowed)) {
  if (obj === "session" || obj === "iwinfo" || obj === "luci-rpc") continue;
  for (const m of [].concat(methods)) {
    if (m === "*" || !/^(get|list|info|dump|status)/i.test(m)) continue;
    if (looksUseful.test(obj) || looksUseful.test(m)) await probe(obj, m);
  }
  if (obj.startsWith("hostapd.")) await probe(obj, "get_clients");
}

// 5. Per-device traffic candidates. get_clients lists devices but has no byte
// counters, so look at per-connection accounting and the wildcard objects.
console.log("\nPer-device traffic");
const ct = await probe("luci", "getConntrackList");
const flows = Array.isArray(ct?.result) ? ct.result : Array.isArray(ct) ? ct : [];
if (flows.length) {
  console.log(`       ${flows.length} flows; fields: ${Object.keys(flows[0]).join(", ")}`);
  console.log(`       byte counters: ${"bytes" in flows[0] ? "YES" : "no (nf_conntrack_acct off?)"}`);
}
await probe("luci", "getRealtimeStats", { mode: "conntrack" });
await probe("luci", "getRealtimeStats", { mode: "wireless" });
await probe("web_api", "get_topology");
await probe("web_api", "get_routers");
for (const obj of Object.keys(allowed).filter((o) => [].concat(allowed[o]).includes("*"))) {
  try {
    const sig = await router.list(obj);
    results[`list ${obj}`] = sig;
    const methods = Object.keys(sig?.[obj] || {});
    console.log(`  ${methods.length ? "YES" : "no "}  list ${obj}  ${methods.join(", ")}`);
  } catch (e) {
    console.log(`  no   list ${obj}  (${e.message})`);
  }
}

// 6. net.info looked like per-device rates — try its read methods.
console.log("\nnet.info rates");
await probe("net.info", "get_ip_list");
await probe("net.info", "get_batch_rate", { detail: true });
for (const type of ["mac", "ip", "lan", "all"]) await probe("net.info", "get_batch_rate", { type, detail: true });
const someMac = (results["web_api.get_clients"]?.data?.dev_list || [])[0]?.addr;
if (someMac) await probe("net.info", "get_mac_rate", { object: someMac, detail: true });
await probe("net.info", "get_iface_rate", { name: "br-lan" });

// mtk.wifi replies include the WiFi key in plain text — never write it to disk.
const redact = (k, v) => (/wpapsk|wepkey|password|passwd|secret|^key$/i.test(k) && typeof v === "string" && v ? "[redacted]" : v);
await writeFile(new URL("./router-probe.json", import.meta.url), JSON.stringify(results, redact, 2));
console.log("\nFull replies saved to router-probe.json");
