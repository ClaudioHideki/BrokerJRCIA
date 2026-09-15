import { createHmac } from 'node:crypto';

import ipaddr from 'ipaddr.js';

import { deriveIdentityRateLimitKey, deriveIpRateLimitKey } from '@jrc/security';

export interface RateLimitKeysInput {
  email: string;
  ipAddress: string;
  ipSecret: string;
  identitySecret: string;
}

export function createRateLimitKeys(input: RateLimitKeysInput) {
  return {
    identity: `identity:${deriveIdentityRateLimitKey(input.email, input.identitySecret)}`,
    ip: `ip:${deriveIpRateLimitKey(input.ipAddress, input.ipSecret)}`,
  } as const;
}

export function createSelectionRateLimitKeys(input: Omit<RateLimitKeysInput, 'email'> & {
  selectionToken: string;
}) {
  if (Buffer.byteLength(input.identitySecret, 'utf8') < 32) {
    throw new Error('HMAC secret must contain at least 32 bytes');
  }
  const identityDigest = createHmac('sha256', input.identitySecret)
    .update(input.selectionToken, 'utf8')
    .digest('hex');
  return {
    identity: `identity:${identityDigest}`,
    ip: `ip:${deriveIpRateLimitKey(input.ipAddress, input.ipSecret)}`,
  } as const;
}

export interface ClientIpInput {
  remoteAddress: string;
  forwardedFor?: string | string[];
  trustedProxyCidrs: readonly string[];
}

function comparableAddress(address: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  if (address.kind() !== 'ipv6') return address;
  const ipv6 = address as ipaddr.IPv6;
  return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
}

function canonicalAddress(value: string, label: string): string {
  if (!ipaddr.isValid(value)) throw new Error(`Invalid ${label} IP address`);
  return comparableAddress(ipaddr.parse(value)).toString();
}

function isTrusted(address: string, cidrs: readonly string[]): boolean {
  const parsedAddress = comparableAddress(ipaddr.parse(address));
  return cidrs.some((cidr) => {
    let parsedCidr: [ipaddr.IPv4 | ipaddr.IPv6, number];
    try {
      parsedCidr = ipaddr.parseCIDR(cidr);
    } catch {
      throw new Error('Invalid trusted proxy CIDR');
    }
    const rangeAddress = comparableAddress(parsedCidr[0]);
    if (rangeAddress.kind() !== parsedAddress.kind()) return false;
    const originalRange = parsedCidr[0];
    const isMappedRange = originalRange.kind() === 'ipv6'
      && (originalRange as ipaddr.IPv6).isIPv4MappedAddress();
    const prefix = isMappedRange ? parsedCidr[1] - 96 : parsedCidr[1];
    return parsedAddress.match(rangeAddress, prefix);
  });
}

export function resolveClientIp(input: ClientIpInput): string {
  const remoteAddress = canonicalAddress(input.remoteAddress, 'remote');
  // Validate configured CIDRs even when the immediate peer is not trusted.
  for (const cidr of input.trustedProxyCidrs) {
    try { ipaddr.parseCIDR(cidr); } catch { throw new Error('Invalid trusted proxy CIDR'); }
  }
  if (!input.forwardedFor || !isTrusted(remoteAddress, input.trustedProxyCidrs)) {
    return remoteAddress;
  }
  const forwardedHeader = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(',')
    : input.forwardedFor;
  const firstHop = forwardedHeader.split(',')[0]?.trim();
  if (!firstHop) throw new Error('Invalid forwarded IP address');
  return canonicalAddress(firstHop, 'forwarded');
}
