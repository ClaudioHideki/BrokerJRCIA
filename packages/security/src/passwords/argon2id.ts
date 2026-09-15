import argon2 from 'argon2';

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

const DUMMY_PASSWORD = 'jrc-dummy-password-verification-value';

export interface PasswordCryptoDependencies {
  hash(password: string): Promise<string>;
  verify(hash: string, candidate: string): Promise<boolean>;
}

export interface PasswordVerifier {
  verifyPasswordOrDummy(candidate: string, passwordHash: string | null): Promise<boolean>;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

export async function verifyPassword(hash: string, candidate: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    return false;
  }
}

const DEFAULT_CRYPTO: PasswordCryptoDependencies = {
  hash: hashPassword,
  verify: verifyPassword,
};

export async function initializePasswordVerifier(
  crypto: PasswordCryptoDependencies = DEFAULT_CRYPTO,
): Promise<PasswordVerifier> {
  const dummyHash = await crypto.hash(DUMMY_PASSWORD);

  return Object.freeze({
    async verifyPasswordOrDummy(candidate: string, passwordHash: string | null): Promise<boolean> {
      let matches = false;
      try {
        matches = await crypto.verify(passwordHash ?? dummyHash, candidate);
      } catch {
        matches = false;
      }

      return passwordHash === null ? false : matches;
    },
  });
}

export async function verifyPasswordOrDummy(
  verifier: PasswordVerifier,
  candidate: string,
  passwordHash: string | null,
): Promise<boolean> {
  return verifier.verifyPasswordOrDummy(candidate, passwordHash);
}
