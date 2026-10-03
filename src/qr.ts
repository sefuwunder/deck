/* qr.ts — minimal QR encoder: byte mode, ECC level M, versions 1-8, auto best mask.
 * Zero deps. Tables cross-checked against the published ECC table and
 * verified module-for-module against a reference implementation. */
export interface QrCode {
  size: number;
  dark(x: number, y: number): boolean;
}

interface VerInfo {
  total: number; eccPerBlock: number;
  g1: number; g1d: number; g2: number; g2d: number;
  align: number[]; rem: number; cap: number;
}

// ECC level M. data codewords = g1*g1d + g2*g2d.
const VERSIONS: (VerInfo | null)[] = [
  null,
  { total: 26, eccPerBlock: 10, g1: 1, g1d: 16, g2: 0, g2d: 0, align: [], rem: 0, cap: 14 },
  { total: 44, eccPerBlock: 16, g1: 1, g1d: 28, g2: 0, g2d: 0, align: [6, 18], rem: 7, cap: 26 },
  { total: 70, eccPerBlock: 26, g1: 1, g1d: 44, g2: 0, g2d: 0, align: [6, 22], rem: 7, cap: 42 },
  { total: 100, eccPerBlock: 18, g1: 2, g1d: 32, g2: 0, g2d: 0, align: [6, 26], rem: 7, cap: 62 },
  { total: 134, eccPerBlock: 24, g1: 2, g1d: 43, g2: 0, g2d: 0, align: [6, 30], rem: 7, cap: 84 },
  { total: 172, eccPerBlock: 16, g1: 4, g1d: 27, g2: 0, g2d: 0, align: [6, 34], rem: 7, cap: 106 },
  { total: 196, eccPerBlock: 18, g1: 4, g1d: 31, g2: 0, g2d: 0, align: [6, 22, 38], rem: 0, cap: 122 },
  { total: 242, eccPerBlock: 22, g1: 2, g1d: 38, g2: 2, g2d: 39, align: [6, 24, 42], rem: 0, cap: 152 },
];

/* ---------- Reed-Solomon over GF(256) ---------- */
const EXP = new Array(512);
const LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
function rsRemainder(data: number[], eccLen: number): number[] {
  // generator = product_{i=0}^{eccLen-1} (x - a^i)
  let gen = [1];
  for (let i = 0; i < eccLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gfMul(gen[j], EXP[i]); // * a^i  (subtraction = addition)
      next[j + 1] ^= gen[j];
    }
    gen = next;
  }
  const res = new Array(eccLen).fill(0);
  for (const d of data) {
    const factor = d ^ res.shift()!;
    res.push(0);
    // gen is lowest-degree-first [g0..g_{n-1}, 1]; s[j] takes g_{n-1-j}
    for (let j = 0; j < eccLen; j++) res[j] ^= gfMul(gen[eccLen - 1 - j], factor);
  }
  return res;
}

/* ---------- bit buffer ---------- */
class Bits {
  arr: number[] = [];
  push(val: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.arr.push((val >>> i) & 1);
  }
}

/* ---------- format info ---------- */
function formatBits(mask: number): number {
  const data = mask; // ec level M = 0b00, so data = (0 << 3) | mask
  let rem = data;
  // BCH: divide data<<10 by 0x537
  let bits = data << 10;
  const poly = 0x537;
  while (bits >= 1 << 10) {
    const shift = Math.floor(Math.log2(bits)) - 10;
    bits ^= poly << shift;
  }
  return (((data << 10) | bits) ^ 0x5412) & 0x7fff;
}

/* ---------- mask patterns ---------- */
function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function penalty(m: number[][]): number {
  const n = m.length;
  let p = 0;
  // N1: runs in rows and columns
  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) {
      if (m[y][x] === m[y][x - 1]) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  for (let x = 0; x < n; x++) {
    let run = 1;
    for (let y = 1; y < n; y++) {
      if (m[y][x] === m[y - 1][x]) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
  }
  // N2: 2x2 blocks
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  // N3: finder-like patterns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  function match(line: number[], at: number, pat: number[]): boolean {
    for (let k = 0; k < 11; k++) if (line[at + k] !== pat[k]) return false;
    return true;
  }
  for (let y = 0; y < n; y++)
    for (let x = 0; x <= n - 11; x++) {
      if (match(m[y], x, pat1) || match(m[y], x, pat2)) p += 40;
    }
  for (let x = 0; x < n; x++) {
    const col = m.map((row) => row[x]);
    for (let y = 0; y <= n - 11; y++) {
      if (match(col, y, pat1) || match(col, y, pat2)) p += 40;
    }
  }
  // N4: dark balance
  let dark = 0;
  for (const row of m) for (const c of row) dark += c;
  const pct = (dark * 100) / (n * n);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

/* ---------- encoder ---------- */
export function encodeQr(text: string, forceMask?: number): QrCode {
  const bytes = Buffer.from(text, "utf8");
  let ver = 0;
  for (let v = 1; v <= 8; v++) {
    if (VERSIONS[v]!.cap >= bytes.length) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error("text too long for QR (max 152 bytes at V8-M)");
  const info = VERSIONS[ver]!;
  const size = ver * 4 + 17;
  const dataCodewords = info.g1 * info.g1d + info.g2 * info.g2d;

  // data bits
  const bb = new Bits();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, 8); // char count (versions 1-9)
  for (const b of bytes) bb.push(b, 8);
  const capacityBits = dataCodewords * 8;
  bb.push(0, Math.min(4, capacityBits - bb.arr.length)); // terminator
  while (bb.arr.length % 8 !== 0) bb.push(0, 1);
  const data: number[] = [];
  for (let i = 0; i < bb.arr.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bb.arr[i + j];
    data.push(w);
  }
  for (let pad = 0xEC; data.length < dataCodewords; pad ^= 0xEC ^ 0x11) data.push(pad);

  // split into blocks, RS, interleave
  const blocks: number[][] = [];
  let off = 0;
  for (let b = 0; b < info.g1; b++) {
    blocks.push(data.slice(off, off + info.g1d));
    off += info.g1d;
  }
  for (let b = 0; b < info.g2; b++) {
    blocks.push(data.slice(off, off + info.g2d));
    off += info.g2d;
  }
  const eccBlocks = blocks.map((bl) => rsRemainder(bl, info.eccPerBlock));
  const maxData = Math.max(info.g1d, info.g2d);
  const final: number[] = [];
  for (let i = 0; i < maxData; i++)
    for (const bl of blocks) if (i < bl.length) final.push(bl[i]);
  for (let i = 0; i < info.eccPerBlock; i++)
    for (const eb of eccBlocks) final.push(eb[i]);

  // matrix + function map
  const mod: number[][] = Array.from({ length: size }, () => new Array(size).fill(-1));
  const isFunc: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  function setF(x: number, y: number, v: number): void {
    mod[y][x] = v;
    isFunc[y][x] = true;
  }
  function finder(cx: number, cy: number): void {
    for (let dy = -1; dy <= 7; dy++)
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const in7 = dx >= 0 && dx < 7 && dy >= 0 && dy < 7;
        if (!in7) {
          setF(x, y, 0); // separator
          continue;
        }
        const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const core = dx >= 2 && dx < 5 && dy >= 2 && dy < 5;
        setF(x, y, edge || core ? 1 : 0);
      }
  }
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  // timing
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setF(i, 6, v);
    setF(6, i, v);
  }
  // alignment
  const ap = info.align;
  for (const ay of ap)
    for (const ax of ap) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === ap[ap.length - 1]) || (ax === ap[ap.length - 1] && ay === 6))
        continue; // overlaps finders
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dy) === 2;
          setF(ax + dx, ay + dy, edge || (dx === 0 && dy === 0) ? 1 : 0);
        }
    }
  // dark module
  setF(8, 4 * ver + 9, 1);
  // version info (versions 7+) — reserve cells; bits written after masking
  const verCells: [number, number][] = [];
  if (ver >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      verCells.push([a, b], [b, a]);
    }
    for (const [x, y] of verCells) isFunc[y][x] = true;
  }
  // reserve format info areas
  const fmtCells: [number, number][] = [];
  for (let i = 0; i <= 5; i++) fmtCells.push([8, i], [i, 8]);
  fmtCells.push([8, 7], [7, 8], [8, 8]);
  for (let i = 0; i < 8; i++) fmtCells.push([size - 1 - i, 8]);
  for (let i = 0; i < 7; i++) fmtCells.push([8, size - 1 - i]);
  for (const [x, y] of fmtCells) isFunc[y][x] = true;

  // data placement (zigzag, skipping function modules)
  let bit = 0;
  const totalBits = final.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunc[y][x] || mod[y][x] !== -1) continue;
        const v = bit < totalBits ? (final[bit >>> 3] >>> (7 - (bit & 7))) & 1 : 0;
        mod[y][x] = v;
        bit++;
      }
    }
  }

  // choose best mask (data modules only), or honor the forced mask
  const masked: number[][] = mod.map((r) => r.slice());
  function applyMask(mask: number): void {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const v = mod[y][x];
        masked[y][x] = v < 0 ? 0 : isFunc[y][x] ? v : v ^ (maskBit(mask, x, y) ? 1 : 0);
      }
  }
  let best: number;
  if (forceMask !== undefined) {
    best = forceMask;
    applyMask(best);
  } else {
    best = 0;
    let bestPen = Infinity;
    const trial: number[][] = mod.map((r) => r.slice());
    for (let mask = 0; mask < 8; mask++) {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const v = mod[y][x];
          trial[y][x] = v < 0 ? 0 : isFunc[y][x] ? v : v ^ (maskBit(mask, x, y) ? 1 : 0);
        }
      const p = penalty(trial);
      if (p < bestPen) {
        bestPen = p;
        best = mask;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) masked[y][x] = trial[y][x];
      }
    }
  }

  // format info for chosen mask
  const fb = formatBits(best);
  const bitAt = (i: number) => (fb >>> i) & 1;
  const put = (x: number, y: number, v: number) => {
    masked[y][x] = v;
  };
  for (let i = 0; i <= 5; i++) {
    put(8, i, bitAt(i));
    put(i, 8, bitAt(i));
  }
  put(8, 7, bitAt(6));
  put(7, 8, bitAt(8));
  put(8, 8, bitAt(7));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bitAt(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bitAt(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bitAt(i));

  // version info bits (versions 7+)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const v = (vb >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      masked[b][a] = v;
      masked[a][b] = v;
    }
  }

  return {
    size,
    dark: (x, y) => masked[y][x] === 1,
  };
}

/** Render as a crisp SVG (white quiet zone included). */
export function qrToSvg(qr: QrCode, opts: { scale?: number; dark?: string; light?: string } = {}): string {
  const s = opts.scale || 8;
  const n = qr.size + 8; // 4-module quiet zone each side
  const dark = opts.dark || "#14110d";
  const light = opts.light || "#ffffff";
  let rects = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.dark(x, y)) rects += `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * s}" height="${n * s}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}
