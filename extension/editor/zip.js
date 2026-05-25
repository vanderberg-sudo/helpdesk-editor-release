// zip.js — Tiny client-side zip builder. Stored (no deflate) only — keeps
// the code small and dependency-free. For PNG and WebM, stored mode is fine
// since they're already compressed.
//
// Usage:
//   const zipBlob = await makeZip(new Map([
//     ['index.html', new Blob([html], { type: 'text/html' })],
//     ['assets/foo.png', pngBlob],
//   ]));

export async function makeZip(filesMap) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  const encoder = new TextEncoder();

  for (const [name, data] of filesMap.entries()) {
    const nameBytes = encoder.encode(name);
    const arrayBuffer = data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : encoder.encode(data);

    const crc = crc32(arrayBuffer);
    const size = arrayBuffer.length;

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length + size);
    let p = 0;
    p = writeUint32LE(local, p, 0x04034b50);  // sig
    p = writeUint16LE(local, p, 20);          // version
    p = writeUint16LE(local, p, 0);           // flags
    p = writeUint16LE(local, p, 0);           // method (stored)
    p = writeUint16LE(local, p, 0);           // mod time
    p = writeUint16LE(local, p, 0);           // mod date
    p = writeUint32LE(local, p, crc);         // crc32
    p = writeUint32LE(local, p, size);        // compressed size
    p = writeUint32LE(local, p, size);        // uncompressed size
    p = writeUint16LE(local, p, nameBytes.length); // file name length
    p = writeUint16LE(local, p, 0);           // extra length
    local.set(nameBytes, p); p += nameBytes.length;
    local.set(arrayBuffer, p);

    localRecords.push({ bytes: local, offset });

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    p = 0;
    p = writeUint32LE(central, p, 0x02014b50); // sig
    p = writeUint16LE(central, p, 20);         // version made by
    p = writeUint16LE(central, p, 20);         // version needed
    p = writeUint16LE(central, p, 0);          // flags
    p = writeUint16LE(central, p, 0);          // method
    p = writeUint16LE(central, p, 0);          // mod time
    p = writeUint16LE(central, p, 0);          // mod date
    p = writeUint32LE(central, p, crc);
    p = writeUint32LE(central, p, size);
    p = writeUint32LE(central, p, size);
    p = writeUint16LE(central, p, nameBytes.length);
    p = writeUint16LE(central, p, 0);          // extra
    p = writeUint16LE(central, p, 0);          // comment
    p = writeUint16LE(central, p, 0);          // disk number
    p = writeUint16LE(central, p, 0);          // internal attrs
    p = writeUint32LE(central, p, 0);          // external attrs
    p = writeUint32LE(central, p, offset);     // local header offset
    central.set(nameBytes, p);

    centralRecords.push(central);

    offset += local.length;
  }

  // End of central directory
  let centralSize = 0;
  for (const c of centralRecords) centralSize += c.length;
  const eocd = new Uint8Array(22);
  let p = 0;
  p = writeUint32LE(eocd, p, 0x06054b50);
  p = writeUint16LE(eocd, p, 0);
  p = writeUint16LE(eocd, p, 0);
  p = writeUint16LE(eocd, p, centralRecords.length);
  p = writeUint16LE(eocd, p, centralRecords.length);
  p = writeUint32LE(eocd, p, centralSize);
  p = writeUint32LE(eocd, p, offset);
  p = writeUint16LE(eocd, p, 0);

  const parts = [];
  for (const r of localRecords) parts.push(r.bytes);
  for (const c of centralRecords) parts.push(c);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

function writeUint16LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >> 8) & 0xff;
  return offset + 2;
}
function writeUint32LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >> 8) & 0xff;
  arr[offset + 2] = (val >> 16) & 0xff;
  arr[offset + 3] = (val >>> 24) & 0xff;
  return offset + 4;
}

// CRC32 (standard polynomial 0xEDB88320)
let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      _crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = _crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
