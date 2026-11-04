# vantage

**A host-based network observability agent.**

Reads real interface counters, discovers every device on the LAN, tracks latency and live TCP connections, pulls whole-house data usage straight from the router, and stores 30 days of history in SQLite. No switch, no cloud, no install — runs on Node.

![overview](docs/overview.png)

*Screenshot uses sample data. No real device names, IPs or MACs.*

---

## Why this exists

Most network monitoring needs a managed switch and a server. vantage runs on one laptop and tells you what your network is actually doing. It was built to answer three questions:

1. *Why is my internet slow right now?*
2. *What is every device on my WiFi, and is it alive?*
3. *How much data is the whole house using?*

The third one required reverse-engineering a locked vendor router API. That is the interesting part.

---

## What it captures

| Source | What | How |
|---|---|---|
| This PC | Bytes in/out, errors, link speed, utilisation | Windows adapter statistics (real counters) |
| WiFi | SSID, signal, channel, radio type, rates | `netsh` |
| LAN devices | IP, MAC, vendor (OUI), reachability, RTT | ARP + broadcast sweep + ICMP |
| Live connections | Remote host, port, owning process | `Get-NetTCPConnection` |
| Router (whole house) | Total data used today and this month, signal, radio | Reverse-engineered ubus API |
| Router (every device) | Live upload/download per device, name, which mesh node and band, WiFi signal (dBm) | `net.info`, `web_api.get_routers`, `get_topology` over ubus |
| History | 30 days of samples, latency, speed tests | SQLite, zero dependencies |
| Alerts | Offline devices, weak WiFi, hot links | Toast + rules in `config.json` |

---

## The router reverse-engineering

The router is a **JT 4G/5G CPE** (South African ISP *rain*). Its web UI is a Vue app that talks to a locked JSON-RPC endpoint.

Three traps, in order:

1. **Every endpoint 403s unless you add `?flag=<method>&t=<ms>`** to the URL.
2. **The password is never sent in plaintext.** The UI hashes it as `sha256(salt + ":" + password)` with a random 64-character salt, then sends `{ username, password: hash, salt }`.
3. **The ubus session token is `sessionid`, not `token`.** They look identical. Only one is accepted.

Once past those three, the router exposes `cell.traffic/get_traffic_cfg` (total bytes used by every device combined) and `jytl_api/get_status_info` (5G signal, radio type, WAN status).

The firmware's own minified JavaScript (`/assets/index-*.js`) was the documentation.

---

## A real finding, from my own network

vantage measured the 5G link and reported:

```
Band           n78 (3.5 GHz C-band)
Signal         -84 dBm        ← decent
SINR           24.5 dB        ← excellent, no interference
Channel width  40 MHz         ← only 40% of available
Carrier agg.   none           ← single carrier
```

Download was 28 Mbps. The signal was fine. The bottleneck was **bandwidth allocation** — a 40 MHz slice of n78 and no carrier aggregation. The fix is upstream (plan tier / carrier aggregation), not in the house. The tool turned a guess into a measurement.

---

## What building this taught me about networking

**1. On a switched network, a computer only sees its own traffic.**
WiFi and switches send each frame only to the device it's for, so this laptop can never measure what the phone next to it is downloading. The ARP table only lists devices the PC has already talked to. Pinging the subnet's broadcast address makes every awake device answer, which fills the table in one shot. Per-device traffic needs a vantage point that every packet passes through: the router, or a switch with port mirroring (SPAN).

**2. The router already counts everything. You just have to ask.**
The router does NAT for every device, so it keeps a connection-tracking table (conntrack): one entry per flow (source, destination, ports, protocol), each with byte and packet counters. Adding those up by source IP gives usage per device. This router also computes per-MAC rates itself, split into two paths: **hardware NAT offload** (the fast path, which skips the CPU) and **software NAT**. Count only one and you miss traffic.

**3. Reading a router's permissions before guessing at its API.**
The admin API is JSON-RPC over OpenWrt's `ubus`. Instead of trying endpoints blindly, `session access` returns the ACL: exactly which objects and methods this login may call. The standard `iwinfo assoclist` was blocked, while a vendor method (`net.info.get_mac_rate`) had what I needed. Least privilege, seen from the other side.

**4. Mesh WiFi is a tree, not a star.**
EasyMesh has a controller (the main unit) and agents (extenders), each with an AL MAC. Here the outdoor 5G unit has no WiFi clients at all. Every phone sits on the indoor extender, which reaches the router over a **wired (Ethernet) backhaul**. A star diagram with every device around one router hides that. The real tree shows which link everything depends on.

**5. Signal in dBm, and why "connected" isn't "fine".**
RSSI is logarithmic: every 3 dB is half the power. Rough guide: −60 dBm or better is excellent, −67 is enough for calls, −75 is fair, −85 and below is poor. Several devices here sat between −85 and −95 dBm, which explains slow phones better than any speed test. 2.4 GHz reaches further through walls; 5 GHz is faster but fades sooner.

**6. MAC addresses lie a little.**
The first three bytes (the OUI) identify the maker, but most modern phones use a **randomised, locally administered MAC** per network (the second-lowest bit of the first byte is set, so addresses start with `x2`, `x6`, `xA` or `xE`). Vendor lookup returns nothing for them, so the router's DHCP hostname is the better label. Addresses with the lowest bit set are multicast groups, not devices.

**7. Dual-stack surprises: `localhost` isn't always fast.**
`localhost` resolves to IPv6 `::1` first. The agent only listens on IPv4 `127.0.0.1`, so every request waited about 2 seconds for the IPv6 attempt to fail before falling back. Use the exact address the server listens on.

**8. Throughput, latency and the 5G link are different problems.**
A good signal (−84 dBm, SINR 24.5 dB) still gave 28 Mbps, because the cell allocated a 40 MHz channel with no carrier aggregation. Bandwidth, latency and radio quality each need their own measurement.

**9. Network data is untrusted input.**
Any device on the WiFi picks its own DHCP hostname, so a name like `<img onerror=…>` would run code in a dashboard that inserts names as HTML. Everything from the network gets escaped. The same goes for exposure: an agent with Wake-on-LAN and port-scan endpoints must never be reachable from the internet without a login.

**10. Admin APIs leak more than you expect.**
The router's admin API returns the WiFi key in plain text to any admin session. If the admin password equals the WiFi password, anyone on the WiFi effectively has admin. Use separate passwords.

---

## Run it

```powershell
cd vantage
npm install   # nothing to install — Node 24 ships SQLite
node agent.mjs
```

Open `http://localhost:8123`.

### Make it automatic (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File install-service.ps1
```

Run once. It asks for the router password (saved to `config.local.json`, which is gitignored), starts the agent hidden at every login (restarting it if it crashes, on battery too), and adds a **vantage** shortcut to the Desktop and Start menu. The shortcut opens the dashboard and starts the agent first if it isn't running.

### Configure

Edit `config.json`:

```json
{
  "agent": { "port": 8123, "pollSeconds": 3, "scanSeconds": 15, "latencySeconds": 5 },
  "router": { "enabled": true, "ip": "192.168.0.1", "user": "admin", "pass": "" },
  "retention": { "rawHours": 48, "hourlyDays": 365, "eventDays": 90 },
  "alerts": { "wifiSignalBelow": 45, "linkUtilAbove": 85, "deviceOffline": true, "toasts": true }
}
```

Or use environment variables: `VANTAGE_ROUTER_PASS`, `VANTAGE_HTTP_ADDR`, `VANTAGE_DATABASE_URL` (for the Postgres version).

---

## Architecture

```
┌────────────┐    ┌─────────────┐    ┌────────────┐    ┌────────────┐
│  collector │───▶│   SQLite    │───▶│  HTTP API  │───▶│  dashboard │
│  (Node)    │    │  (30 days)  │    │  (Node)    │    │  (vanilla) │
└────────────┘    └─────────────┘    └────────────┘    └────────────┘
      │
      ├─ Windows adapter counters
      ├─ ARP + broadcast sweep
      ├─ ICMP reachability
      ├─ Get-NetTCPConnection
      └─ router ubus API
```

The companion `vantage` Go project (separate repo, in progress) is the production version: TimescaleDB, Go collector, React UI. This repo is the working prototype that proved the approach.

---

## Security note

Credentials live in `config.json` or environment variables. There is no auth on the HTTP API — this is a single-host tool, not a multi-tenant service. Do not expose port 8123 to the internet.

---

## Requirements

- Windows 10 or 11 (the agent uses `powershell.exe` and Windows netsh)
- Node 24 or newer (uses built-in SQLite)
- A router that speaks UPnP or the JT ubus API (optional — the tool works fully without one)

---

## License

MIT
