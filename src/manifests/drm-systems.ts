/**
 * DRM systems, by the identifiers manifests use for them.
 *
 * One table for HLS and DASH, so the two parsers cannot disagree about which
 * system a stream uses. It only NAMES the system for the refusal message:
 * MediaGrab never downloads protected media (PRD s42), and a parser treats an
 * identifier it does not know as protected too, never as clear.
 *
 * DASH names systems by `ContentProtection@schemeIdUri` (a `urn:uuid:` system
 * id, dashif.org/identifiers/content_protection); HLS by `EXT-X-KEY@KEYFORMAT`
 * (RFC 8216 s4.3.2.4), which is either one of those URNs or a reverse-DNS name.
 */

const SYSTEM_IDS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
  // The W3C "common" PSSH system id, which several systems (ClearKey among them) share.
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'Common Encryption',
};

const KEY_FORMATS: Record<string, string> = {
  'com.apple.streamingkeydelivery': 'FairPlay',
  'com.microsoft.playready': 'PlayReady',
  'com.widevine': 'Widevine',
  // MPEG Common Encryption signalled without naming a system.
  'urn:mpeg:dash:mp4protection:2011': 'Common Encryption',
};

/** The system's name for an HLS KEYFORMAT or a DASH scheme URI, if it is a known one. */
export function drmSystemNamed(identifier: string): string | undefined {
  const id = identifier.trim().toLowerCase();
  const uuid = id.startsWith('urn:uuid:') ? id.slice('urn:uuid:'.length) : id;
  return SYSTEM_IDS[uuid] ?? KEY_FORMATS[id];
}
