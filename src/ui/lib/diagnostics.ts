/**
 * Diagnostics export and "report this site" payload (PRD s48, s49).
 *
 * Nothing here is uploaded. The report is built locally and copied to the
 * clipboard so the user can read exactly what they are about to share before
 * they share it - which is the only honest version of a "send us a report"
 * button in a privacy-first product.
 *
 * Every URL passes through redactUrl, and headers/cookies/tokens never enter
 * the object in the first place.
 */
import { domainOf, redactDeep, redactUrl } from '../../core/redact.ts';
import type { ScanResult } from '../../core/types.ts';

export interface DiagnosticsReport {
  reportVersion: 1;
  extensionVersion: string;
  browser: string;
  createdAt: string;
  domain: string;
  stats: ScanResult['stats'];
  diagnosis?: ScanResult['diagnosis'];
  candidates: Array<{
    url: string;
    kind: string;
    protocol: string;
    format: string;
    source: string;
    score?: number;
    resolution?: string;
    variants: number;
    drm?: boolean;
  }>;
  rejected: Array<{ url: string; reason: string }>;
}

export function buildReport(
  result: ScanResult,
  extensionVersion: string,
  userAgent: string,
): DiagnosticsReport {
  return {
    reportVersion: 1,
    extensionVersion,
    browser: summarizeUserAgent(userAgent),
    createdAt: new Date().toISOString(),
    domain: domainOf(result.pageUrl),
    stats: result.stats,
    ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
    candidates: result.candidates.map((candidate) => ({
      url: redactUrl(candidate.url),
      kind: candidate.kind,
      protocol: candidate.protocol,
      format: candidate.format,
      source: candidate.source,
      ...(candidate.score !== undefined ? { score: candidate.score } : {}),
      ...(candidate.resolution
        ? { resolution: `${candidate.resolution.width}x${candidate.resolution.height}` }
        : {}),
      variants: candidate.variants?.length ?? 0,
      ...(candidate.drm !== undefined ? { drm: candidate.drm } : {}),
    })),
    rejected: result.rejected.slice(0, 50).map((entry) => ({
      url: redactUrl(entry.url),
      reason: entry.reason,
    })),
  };
}

export function reportToJson(report: DiagnosticsReport): string {
  return JSON.stringify(redactDeep(report), null, 2);
}

/**
 * Coarse browser identification. The full user agent is a fingerprinting
 * surface, so the report carries the family and major version only.
 */
export function summarizeUserAgent(userAgent: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ];
  for (const [pattern, name] of patterns) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return 'Unknown browser';
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
