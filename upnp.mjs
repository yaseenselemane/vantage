// Total data for the whole house. The router knows; ask it.
// No dependencies: SSDP over UDP, then plain HTTP + regex on the SOAP reply.
import dgram from "node:dgram";

/* ------------------------------------------------------------------ SSDP */

// Ask the network "who is the internet gateway?" One multicast packet.
export function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = [];

    const msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 2\r\n" +
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n",
    );

    socket.on("message", (buf) => {
      const text = buf.toString();
      const loc = /location:\s*(.+)/i.exec(text);
      if (loc && !found.includes(loc[1].trim())) found.push(loc[1].trim());
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(msg, 0, msg.length, 1900, "239.255.255.250");
    });

    setTimeout(() => {
      socket.close();
      resolve(found);
    }, timeout);
  });
}

/* ------------------------------------------------- describe + control URL */

// The device description XML lists every service with a controlURL.
// We want WANCommonInterfaceConfig (byte counters) and WANIPConnection.
export async function describe(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await res.text();

  const base = new URL(location);
  const url = (path) => {
    try {
      return new URL(path, base).toString();
    } catch {
      return null;
    }
  };

  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  const services = [];

  for (const block of serviceBlocks) {
    const type = (/<serviceType>([^<]+)<\/serviceType>/i.exec(block) || [])[1];
    const control = (/<controlURL>([^<]+)<\/controlURL>/i.exec(block) || [])[1];
    if (type && control) services.push({ type, controlURL: url(control) });
  }

  return {
    services,
    name: (/<friendlyName>([^<]+)<\/friendlyName>/i.exec(xml) || [])[1] || "router",
  };
}

/* ------------------------------------------------------------------- SOAP */

async function soap(controlURL, serviceType, action, body = "") {
  const envelope = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body>
</s:Envelope>`;

  const res = await fetch(controlURL, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(5000),
  });

  return res.text();
}

const field = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]+)</${name}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
};

/* ---------------------------------------------------------------- counters */

let cached = null;

/**
 * Returns the router's own lifetime byte counters for the WAN link:
 * everything every device in the house has used since the router booted.
 */
export async function wanCounters(force = false) {
  if (cached && !force && Date.now() - cached.at < 30000) return cached.data;

  const locations = await discover(2500);

  for (const location of locations) {
    try {
      const desc = await describe(location);
      const common = desc.services.find((s) =>
        /WANCommonInterfaceConfig/i.test(s.type),
      );
      const conn = desc.services.find((s) =>
        /WAN(IP|PPP)Connection/i.test(s.type),
      );

      if (!common) continue;

      const [rxXml, txXml, statXml] = await Promise.all([
        soap(common.controlURL, common.type, "GetTotalBytesReceived"),
        soap(common.controlURL, common.type, "GetTotalBytesSent"),
        conn
          ? soap(conn.controlURL, conn.type, "GetStatusInfo")
          : Promise.resolve(""),
      ]);

      const data = {
        router: desc.name,
        rxBytes: Number(field(rxXml, "NewTotalBytesReceived")) || 0,
        txBytes: Number(field(txXml, "NewTotalBytesSent")) || 0,
        uptimeS: Number(field(statXml, "NewUptime")) || 0,
        status: field(statXml, "NewConnectionStatus") || null,
        at: Date.now(),
      };

      if (data.rxBytes === 0 && data.txBytes === 0) continue;

      cached = { at: Date.now(), data };
      return data;
    } catch {
      // Try the next announced device.
    }
  }

  return null;
}
