/* Bytes to base64, in Deno.
 *
 * Deno has no Buffer. btoa wants a binary string, and building one with
 * String.fromCharCode(...bytes) spreads every byte as an argument — fine on a
 * test string, "Maximum call stack size exceeded" on a real attachment. So the
 * bytes go through in chunks small enough to spread. invoice-pdf does the
 * same thing privately; this is the shared, tested copy.
 */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
