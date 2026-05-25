/**
 * Lightweight platform detection. UA-sniff is good enough here — being
 * wrong only affects cosmetic decisions (chrome toggle visibility, the
 * macOS traffic-light spacer). Never use this for security or
 * correctness-critical branching.
 */

/** True when running on macOS / iOS Safari (UA includes "mac"/"iphone"/etc). */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return /mac|iphone|ipad|ipod/.test(ua);
}
