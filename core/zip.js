// ZIP archives made in the browser, without a library: a folder's transcripts in one download.
// Entries are deflated with the browser's CompressionStream("deflate-raw") (every current browser;
// Safari since 16.4), else stored. Names are UTF-8 (flag bit 11), so Vietnamese names survive, and
// a name used twice gets " (2)". No ZIP64: transcripts stay far below 4 GB and 65,535 files.
// Pure: runs in the browser and in the Node tests.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 a ZIP entry carries. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Raw deflate, or null where the browser can't. */
async function deflate(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A name not used yet: "a.txt", then "a (2).txt". */
function unique(name, used) {
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  let out = name;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${stem} (${n})${ext}`;
  used.add(out.toLowerCase());
  return out;
}

/** A ZIP archive of files [{name, data: string | Uint8Array}], each dated `date` (local time). */
export async function zipFiles(files, date = new Date()) {
  const enc = new TextEncoder(), used = new Set(), parts = [], central = [];
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(unique(f.name, used)), data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const packed = await deflate(data), stored = !packed || packed.length >= data.length, body = stored ? data : packed;
    // the fields a local header and its central directory entry share, from "version needed" on
    const common = (v, at) => {
      v.setUint16(at, 20, true);                 // version needed: 2.0
      v.setUint16(at + 2, 0x0800, true);         // the name is UTF-8
      v.setUint16(at + 4, stored ? 0 : 8, true);
      v.setUint16(at + 6, time, true);
      v.setUint16(at + 8, day, true);
      v.setUint32(at + 10, crc32(data), true);
      v.setUint32(at + 14, body.length, true);
      v.setUint32(at + 18, data.length, true);
      v.setUint16(at + 22, name.length, true);
    };
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    common(local, 4);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);                // made by: 2.0
    common(entry, 6);
    entry.setUint32(42, offset, true);           // where its local header is
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
