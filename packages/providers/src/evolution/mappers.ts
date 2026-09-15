import type {
  ConnectionAction,
  ProviderInstanceLookup,
  ProviderStatus,
  ProvisionedInstance,
} from '../contracts/types.js';
import { evolutionProviderError } from './client.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireRecord(value: unknown): JsonRecord {
  const result = record(value);
  if (result === undefined) {
    throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
  return result;
}

export function mapEvolutionStatus(value: unknown): ProviderStatus {
  if (typeof value !== 'string') {
    throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
  switch (value.toLowerCase()) {
    case 'open':
    case 'connected':
      return 'CONNECTED';
    case 'connecting':
      return 'CONNECTING';
    case 'close':
    case 'closed':
    case 'disconnected':
      return 'DISCONNECTED';
    case 'created':
      return 'CREATED';
    default:
      return 'ERROR';
  }
}

export function mapProvisionedInstance(
  value: unknown,
  expectedInstanceKey: string,
): ProvisionedInstance {
  const envelope = requireRecord(value);
  const instance = requireRecord(envelope.instance);
  if (nonEmptyString(instance.instanceName) !== expectedInstanceKey) {
    throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
  const rawStatus = instance.status ?? instance.connectionStatus;
  return {
    reference: { id: expectedInstanceKey },
    status: mapEvolutionStatus(rawStatus),
  };
}

export function mapConnectionAction(
  value: unknown,
  expiresAt: string,
): ConnectionAction {
  const envelope = requireRecord(value);
  const qrcode = record(envelope.qrcode);
  const pairingCode = nonEmptyString(envelope.pairingCode)
    ?? nonEmptyString(qrcode?.pairingCode);
  if (pairingCode !== undefined) {
    return { type: 'PAIRING_CODE', code: pairingCode, expiresAt };
  }

  const base64 = nonEmptyString(envelope.base64) ?? nonEmptyString(qrcode?.base64);
  if (base64 !== undefined) {
    return {
      type: 'QR_CODE',
      encoding: base64.startsWith('data:') ? 'DATA_URL' : 'BASE64',
      value: base64,
      expiresAt,
    };
  }

  const count = envelope.count ?? qrcode?.count;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
    return { type: 'NONE', reason: 'CONNECTION_PENDING' };
  }

  const instance = record(envelope.instance);
  const state = nonEmptyString(instance?.state) ?? nonEmptyString(instance?.status);
  switch (state?.toLowerCase()) {
    case 'open':
    case 'connected':
      return { type: 'NONE', reason: 'ALREADY_CONNECTED' };
    case 'connecting':
      return { type: 'NONE', reason: 'CONNECTION_PENDING' };
    case 'close':
    case 'closed':
    case 'disconnected':
      return { type: 'NONE', reason: 'NO_USER_ACTION_REQUIRED' };
    default:
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
}

export function mapConnectionState(value: unknown): ProviderStatus {
  const envelope = requireRecord(value);
  const instance = requireRecord(envelope.instance);
  return mapEvolutionStatus(instance.state ?? instance.status);
}

export function mapInstanceLookup(
  value: unknown,
  expectedInstanceKey: string,
): ProviderInstanceLookup {
  if (!Array.isArray(value)) {
    throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
  const match = value.find((entry) => {
    const item = record(entry);
    return nonEmptyString(item?.name) === expectedInstanceKey;
  });
  if (match === undefined) {
    return { exists: false };
  }
  const instance = requireRecord(match);
  return {
    exists: true,
    reference: { id: expectedInstanceKey },
    status: mapEvolutionStatus(instance.connectionStatus ?? instance.status),
  };
}
