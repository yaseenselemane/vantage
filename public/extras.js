// Extra panels: heatmap, latency, speed test, live connections, wake buttons.
// Loaded after the main script, so S / $ / helpers are already defined.

let HISTORY = { hourly: [], latency: [], speed: [] };

async function fetchHistory() {
  try {
    const res = await fetch("/api/v1/history", { cache: "no-store" });
    HISTORY = await res.json();
    renderHeatmap();
    renderSpeed();
    drawLatency();
  } catch {}
}

/* ------------------------------------------------------------- heatmap */

function renderHeatmap() {
  const host = $("#heatGrid");
  if (!host) return;

  const DAYS = 14;
  const now = new Date();
  const cells = new Map();

  (HISTORY.hourly || []).forEach((h) => {
    const d = new Date(Number(h.hour));
    cells.set(d.toDateString() + "|" + d.getHours(), Number(h.bytes) || 0);
  });

  const peak = Math.max(...[...cells.values()], 1);

  let html = "<div></div>";
  for (let h = 0; h < 24; h += 3) {
    html += '<div class="heat-hour">' + String(h).padStart(2, "0") + "</div>";
  }

  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    html +=
      '<div class="heat-day">' +
      (d === 0 ? "today" : day.toLocaleDateString([], { weekday: "short" })) +
      "</div>";

    for (let h = 0; h < 24; h++) {
      const v = cells.get(day.toDateString() + "|" + h) || 0;
      const r = v / peak;
      const bg =
        v === 0
          ? "rgba(255,255,255,.045)"
          : "rgba(110,123,255," + (0.12 + r * 0.8).toFixed(2) + ")";
      const tip =
        day.toLocaleDateString() +
        " " +
        String(h).padStart(2, "0") +
        ":00 — " +
        (v ? (v / 1e9).toFixed(2) + " GB" : "quiet");
      html += '<div class="heat-cell" style="background:' + bg + '" title="' + tip + '"></div>';
    }
  }

  host.innerHTML = html;
  $("#heatKey").innerHTML =
    "<span>quiet</span>" +
    [0.08, 0.25, 0.45, 0.65, 0.9]
      .map((a) => '<i style="background:rgba(110,123,255,' + a + ')"></i>')
      .join("") +
    "<span>busy</span><span style='margin-left:auto'>" +
    (HISTORY.hourly || []).length +
    " hours stored</span>";
}

/* --------------------------------------------------------------- speed */

function renderSpeed() {
  const host = $("#speedBody");
  if (!host) return;

  const last = (HISTORY.speed || [])[0];

  const block = (label, value, unit, colour) =>
    '<div><div class="k" style="font-size:9.5px;font-weight:650;letter-spacing:.09em;' +
    'text-transform:uppercase;color:var(--text-3)">' + label + "</div>" +
    '<div style="margin-top:2px"><span class="num" style="font-size:22px;font-weight:650;' +
    'letter-spacing:-.02em;color:' + colour + '">' + value + "</span>" +
    '<span style="font-size:10.5px;color:var(--text-3);margin-left:4px">' + unit + "</span></div></div>";

  host.innerHTML =
    '<div style="display:flex;gap:18px;margin-bottom:12px">' +
    block("Down", last ? Math.round(last.down_mbps) : "—", "Mbps", "var(--accent)") +
    block("Up", last ? Math.round(last.up_mbps) : "—", "Mbps", "var(--violet)") +
    block("Ping", last && last.latency_ms != null ? Math.round(last.latency_ms) : "—", "ms", "var(--up)") +
    "</div>" +
    '<button class="mini-btn" id="speedBtn" style="width:100%;height:30px;justify-content:center">' +
    "Run speed test</button>" +
    '<div style="margin-top:8px;font-size:10px;color:var(--text-3)">' +
    (last ? "last run " + new Date(Number(last.t)).toLocaleString() : "never run") +
    "</div>";

  $("#speedBtn").addEventListener("click", runSpeedTest);
}

async function runSpeedTest() {
  const btn = $("#speedBtn");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Testing… about 20 seconds";
  try {
    const res = await fetch("/api/v1/speedtest", { method: "POST" });
    const result = await res.json();
    if (result.downMbps) {
      HISTORY.speed = [
        { t: result.at, down_mbps: result.downMbps, up_mbps: result.upMbps, latency_ms: result.latencyMs },
        ...(HISTORY.speed || []),
      ];
    }
    renderSpeed();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Failed — is the agent running?";
    }
    return;
  }
  fetchSnapshot();
}

/* ------------------------------------------------------------- latency */

function drawLatency() {
  const canvas = $("#latency");
  if (!canvas) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = r.width, h = r.height;
  ctx.clearRect(0, 0, w, h);

  const rows = HISTORY.latency || [];
  if (rows.length < 2) {
    ctx.fillStyle = "#5a636d";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Collecting latency…", w / 2, h / 2);
    return;
  }

  const padL = 34, padR = 8, padT = 8, padB = 16;
  const cw = w - padL - padR, ch = h - padT - padB;

  const times = [...new Set(rows.map((x) => Number(x.minute)))].sort((a, b) => a - b);
  const peak = Math.max(...rows.map((x) => Number(x.worst) || 0), 20) * 1.2;

  const xAt = (t) =>
    padL + ((t - times[0]) / Math.max(times[times.length - 1] - times[0], 1)) * cw;
  const yAt = (v) => padT + ch - (v / peak) * ch;

  const groups = { internet: [], router: [] };
  rows.forEach((row) => {
    const key = row.target === "router" ? "router" : "internet";
    groups[key].push([xAt(Number(row.minute)), yAt(Number(row.ms) || 0)]);
  });

  const line = (pts, colour) => {
    if (pts.length < 2) return;
    pts.sort((a, b) => a[0] - b[0]);

    const g = ctx.createLinearGradient(0, padT, 0, padT + ch);
    g.addColorStop(0, colour + "44");
    g.addColorStop(1, colour + "00");

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(pts[pts.length - 1][0], padT + ch);
    ctx.lineTo(pts[0][0], padT + ch);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  line(groups.internet, "#34D399");
  line(groups.router, "#FBBF24");

  ctx.fillStyle = "#5a636d";
  ctx.font = "9.5px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const y = padT + (ch / 3) * i;
    ctx.fillText(Math.round(peak - (peak / 3) * i) + "ms", padL - 6, y);
  }

  const worst = Math.max(...rows.map((x) => Number(x.worst) || 0));
  $("#latMeta").textContent =
    "worst " + Math.round(worst) + "ms · " + rows.length + " samples";
}

/* --------------------------------------------------------- connections */

async function renderConnections() {
  const host = $("#connList");
  if (!host) return;
  try {
    const res = await fetch("/api/v1/connections", { cache: "no-store" });
    const { connections } = await res.json();
    const list = connections || [];

    $("#connHint").textContent =
      list.length + " live connections · updates every 5 seconds";

    if (!list.length) {
      host.innerHTML =
        '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:11.5px">' +
        "Nothing open right now.</div>";
      return;
    }

    const byApp = new Map();
    list.forEach((c) => {
      const key = c.pid || "?";
      if (!byApp.has(key)) byApp.set(key, { port: c.localPort, proc: c.process, remotes: [] });
      byApp.get(key).remotes.push(c.remote + ":" + c.remotePort);
    });

    host.innerHTML = [...byApp.entries()]
      .sort((a, b) => b[1].remotes.length - a[1].remotes.length)
      .slice(0, 24)
      .map(
        ([pid, v]) =>
          '<div class="conn-row"><span class="proc">' + (v.proc || "PID " + pid) + "</span>" +
          '<span class="addr">' + v.remotes.slice(0, 2).join("  ") +
          (v.remotes.length > 2 ? "  +" + (v.remotes.length - 2) : "") +
          "</span></div>",
      )
      .join("");
  } catch {}
}

/* --------------------------------------------------------------- boot */

function hookWakeButtons() {
  document.querySelectorAll(".device").forEach((card) => {
    if (card.querySelector(".mini-btn")) return;
    const foot = card.querySelector(".dev-foot");
    if (!foot) return;
    const mac = foot.dataset.mac;
    if (!mac) return;
    const online = foot.dataset.online === "1";
    if (online) return;

    const btn = document.createElement("button");
    btn.className = "mini-btn";
    btn.textContent = "Wake";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "Sent";
      try {
        await fetch("/api/v1/wake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mac }),
        });
      } catch {}
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Wake";
      }, 4000);
    });
    foot.appendChild(btn);
  });
}

fetchHistory();
renderConnections();
setInterval(fetchHistory, 15000);
setInterval(renderConnections, 5000);
setInterval(hookWakeButtons, 3000);
setInterval(drawLatency, 5000);
window.addEventListener("resize", drawLatency);
