import { createHash, timingSafeEqual } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';

export interface SecretInputStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: (...arguments_: any[]) => void): unknown;
  off(event: string, listener: (...arguments_: any[]) => void): unknown;
}

export interface SecretOutputStream {
  write(chunk: string): unknown;
}

export interface SecretSignalSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface SecretInputOptions {
  input?: SecretInputStream;
  output?: SecretOutputStream;
  signalSource?: SecretSignalSource;
  initializeKeypressEvents?: (input: SecretInputStream) => void;
}

export async function readSecret(
  prompt: string,
  options: SecretInputOptions = {},
): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const signalSource = options.signalSource ?? process;
  if (!input.isTTY) {
    throw new Error('Secure input requires an interactive TTY');
  }

  output.write(prompt);
  const initializeKeypressEvents = options.initializeKeypressEvents
    ?? ((stream: SecretInputStream) => emitKeypressEvents(stream as NodeJS.ReadStream));
  initializeKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let secret = '';
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return false;
      }
      settled = true;
      input.off('keypress', onKeypress);
      input.off('error', onError);
      input.off('end', onEnd);
      input.off('close', onClose);
      signalSource.off('SIGINT', onSigint);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      return true;
    };
    const cancel = (message: string, cause?: unknown) => {
      if (cleanup()) {
        reject(cause instanceof Error ? cause : new Error(message));
      }
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cancel('Secure input cancelled');
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (cleanup()) {
          resolve(secret);
        }
        return;
      }
      if (key.name === 'backspace') {
        secret = secret.slice(0, -1);
        return;
      }
      if (character && !key.ctrl) {
        secret += character;
      }
    };
    const onError = (error: unknown) => cancel('Secure input failed', error);
    const onEnd = () => cancel('Secure input ended before completion');
    const onClose = () => cancel('Secure input closed before completion');
    const onSigint = () => cancel('Secure input cancelled');
    input.on('keypress', onKeypress);
    input.on('error', onError);
    input.on('end', onEnd);
    input.on('close', onClose);
    signalSource.on('SIGINT', onSigint);
  });
}

function digestCredential(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createAdministrativeCredentialVerifier(expectedCredential: string) {
  if (expectedCredential.length < 32) {
    throw new Error('JRC_TENANT_ADMIN_CREDENTIAL must contain at least 32 characters');
  }
  const expectedDigest = digestCredential(expectedCredential);
  return async function verifyAdministrativeCredential(candidate: string): Promise<boolean> {
    return timingSafeEqual(expectedDigest, digestCredential(candidate));
  };
}
