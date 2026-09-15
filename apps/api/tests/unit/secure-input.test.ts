import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  createAdministrativeCredentialVerifier,
  readSecret,
  type SecretInputStream,
  type SecretOutputStream,
} from '../../src/commands/secure-input.js';

class FakeTty extends EventEmitter implements SecretInputStream {
  isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;

  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    return this;
  }

  pause() {
    this.pauseCalls += 1;
    return this;
  }
}

class FakeOutput implements SecretOutputStream {
  value = '';

  write(chunk: string) {
    this.value += chunk;
    return true;
  }
}

function startRead(input: FakeTty, output: FakeOutput) {
  return readSecret('Secret: ', {
    input,
    output,
    signalSource: input,
    initializeKeypressEvents: () => undefined,
  });
}

describe('secure input', () => {
  it('não ecoa caracteres e sempre restaura o modo original ao concluir', async () => {
    const input = new FakeTty();
    const output = new FakeOutput();
    const result = startRead(input, output);

    input.emit('keypress', 's', { name: 's' });
    input.emit('keypress', 'e', { name: 'e' });
    input.emit('keypress', '', { name: 'return' });

    await expect(result).resolves.toBe('se');
    expect(output.value).toBe('Secret: \n');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCalls).toBe(1);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount('keypress')).toBe(0);
  });

  it.each([
    ['error', new Error('input failed')],
    ['end', undefined],
    ['close', undefined],
    ['SIGINT', undefined],
  ] as const)('faz cleanup idempotente quando recebe %s', async (event, detail) => {
    const input = new FakeTty();
    input.isRaw = true;
    const output = new FakeOutput();
    const result = startRead(input, output);

    input.emit(event, detail);
    input.emit('close');

    await expect(result).rejects.toThrow(/input|cancel/i);
    expect(input.rawModes).toEqual([true, true]);
    expect(input.pauseCalls).toBe(1);
    expect(output.value).toBe('Secret: \n');
    for (const eventName of ['keypress', 'error', 'end', 'close', 'SIGINT']) {
      expect(input.listenerCount(eventName)).toBe(0);
    }
  });

  it('compara credencial administrativa sem aceitar segredo curto', async () => {
    expect(() => createAdministrativeCredentialVerifier('short')).toThrow(/at least 32/i);
    const expected = 'a-secure-local-administrative-credential';
    const verify = createAdministrativeCredentialVerifier(expected);

    await expect(verify(expected)).resolves.toBe(true);
    await expect(verify('a-different-local-administrative-secret')).resolves.toBe(false);
  });
});
