// Tiny SNMP v2c GET. If a device speaks SNMP we get real counters from it.
import dgram from "node:dgram";

const tlv = (tag, payload) => {
  const len = payload.length;
  const head = [tag];
  if (len < 128) head.push(len);
  else {
    const bytes = [];
    let n = len;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>= 8;
    }
    head.push(0x80 | bytes.length, ...bytes);
  }
  return Buffer.from([...head, ...payload]);
};

const int = (v) => {
  const bytes = [];
  let n = v;
  if (n === 0) bytes.push(0);
  while (n > 0) {
    bytes.push(n & 0xff);
    n >>= 8;
  }
  bytes.reverse();
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, bytes);
};

const oid = (str) => {
  const parts = str.split(".").map(Number);
  const body = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 128) body.push(p);
    else {
      const chunk = [];
      let n = p;
      while (n > 0) {
        chunk.unshift(n & 0x7f);
        n >>= 7;
      }
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
      body.push(...chunk);
    }
  }
  return tlv(0x06, body);
};

export function get(target, community, oidStr, timeout = 1500) {
  const varbind = tlv(0x30, Buffer.concat([oid(oidStr), tlv(0x05, Buffer.alloc(0))]));
  const pdu = tlv(
    0xa0,
    Buffer.concat([
      int(Math.floor(Math.random() * 0x7fffffff)),
      int(0),
      int(0),
      tlv(0x30, varbind),
    ]),
  );
  const packet = tlv(0x30, Buffer.concat([int(1), tlv(0x04, Buffer.from(community)), pdu]));

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.close();
      resolve(result);
    };

    socket.once("error", () => finish(null));
    socket.on("message", (buf) => {
      // The value is the last primitive in the reply. Parsing the whole tree
      // is unnecessary: read the tail, which is where a single varbind lands.
      const text = buf.toString("binary");
      const ascii = buf.toString("latin1").replace(/[^\x20-\x7e]/g, "");
      if (buf[buf.length - 1] === 0x05) return finish({ value: null, raw: text });

      // Counters are encoded as integers; the last 4-8 bytes are the value.
      const slice = buf.subarray(buf.length - 8);
      let value = 0;
      for (const b of slice) value = value * 256 + b;
      finish({ value, ascii });
    });

    socket.bind(() => {
      socket.send(packet, 0, packet.length, 161, target, () => {});
      setTimeout(() => finish(null), timeout);
    });
  });
}
