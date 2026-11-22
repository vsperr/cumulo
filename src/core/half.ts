const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

/**
 * IEEE 754 binary32 to binary16.
 *
 * The render volume is uploaded as half floats rather than full floats
 * because linear filtering of 32-bit float textures is an optional WebGL2
 * extension that some drivers advertise but do not apply to 3D textures —
 * ANGLE on Metal among them, which renders the cloud as a lattice of visible
 * voxels. Half-float filtering is core, so it is smooth everywhere, and the
 * frame is half the size to transfer.
 */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = i32[0];
  let bits = (x >> 16) & 0x8000; // sign
  let m = (x >> 12) & 0x07ff; // mantissa, with rounding bit
  const e = (x >> 23) & 0xff; // exponent

  if (e < 103) return bits; // underflows to zero
  if (e > 142) {
    // overflow to infinity, or pass a NaN through
    bits |= 0x7c00;
    bits |= e === 255 && (x & 0x007fffff) ? 0x0200 : 0;
    return bits;
  }
  if (e < 113) {
    // subnormal
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1; // round to nearest even
  return bits;
}
