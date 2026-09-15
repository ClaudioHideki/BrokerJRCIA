import { describe, expect, it } from 'vitest';

import { createTenantCreator } from '../../src/modules/organizations/tenant-create.js';

const ORGANIZATION_ID = '65fe3ab1-a241-417f-9c28-6ba067b90d66';
const OWNER_ID = 'fd7288c8-a6b0-4563-ac49-8db27d5d9db7';
const PROVIDER_ACCOUNT_ID = '36dcebd8-a2fb-46ad-83c0-9e31e163b32a';
const REQUEST_ID = 'a919ac52-a95c-4626-a5a4-3ac40ddd1728';

interface FakeTransaction {
  readonly marker: 'admin-transaction';
}

function baseDependencies() {
  const transaction: FakeTransaction = { marker: 'admin-transaction' };
  return {
    transaction,
    dependencies: {
      runInAdminTransaction: async <T>(operation: (tx: FakeTransaction) => Promise<T>) =>
        operation(transaction),
      verifyAdministrativeCredential: async (credential: string) =>
        credential === 'valid-admin-secret-canary',
      hashPassword: async (password: string) => `$argon2id$new:${password}`,
      countOrganizations: async (_tx: FakeTransaction) => 1,
      findUserByEmailForUpdate: async (_tx: FakeTransaction, _email: string) => null,
      createOrganization: async (
        _tx: FakeTransaction,
        input: { name: string; slug: string },
      ) => ({
        id: ORGANIZATION_ID,
        name: input.name,
        slug: input.slug,
        status: 'ACTIVE' as const,
      }),
      createUser: async (
        _tx: FakeTransaction,
        input: { email: string; passwordHash: string },
      ) => ({ id: OWNER_ID, email: input.email, status: 'ACTIVE' as const }),
      createOwnerMembership: async (
        _tx: FakeTransaction,
        _input: { organizationId: string; userId: string },
      ) => undefined,
      ensureLogicalBaileysAccount: async (_tx: FakeTransaction, organizationId: string) => ({
        id: PROVIDER_ACCOUNT_ID,
        organizationId,
        provider: 'BAILEYS' as const,
        name: 'baileys',
        externalReference: null,
        credentialReference: null,
      }),
      writeTenantAudit: async (_tx: FakeTransaction, _event: unknown) => undefined,
    },
  };
}

function createNewInput() {
  return {
    administrativeCredential: 'valid-admin-secret-canary',
    organizationName: 'Cliente',
    organizationSlug: 'cliente',
    ownerMode: 'CREATE_NEW' as const,
    ownerEmail: ' New.Owner@Example.test ',
    ownerPassword: 'owner-password-canary',
    requestId: REQUEST_ID,
  };
}

function linkExistingInput() {
  return {
    administrativeCredential: 'valid-admin-secret-canary',
    organizationName: 'Cliente',
    organizationSlug: 'cliente',
    ownerMode: 'LINK_EXISTING' as const,
    ownerEmail: ' Existing@Example.test ',
    confirmLinkExisting: true,
    requestId: REQUEST_ID,
  };
}

const invalidTenantInputs: Array<{
  label: string;
  override: Partial<ReturnType<typeof createNewInput>>;
}> = [
  { label: 'nome vazio após trim', override: { organizationName: '   ' } },
  { label: 'nome acima de 200 caracteres', override: { organizationName: 'n'.repeat(201) } },
  { label: 'slug vazio após trim', override: { organizationSlug: '   ' } },
  { label: 'slug acima de 100 caracteres', override: { organizationSlug: 's'.repeat(101) } },
  { label: 'e-mail vazio após trim', override: { ownerEmail: '   ' } },
  { label: 'e-mail malformado', override: { ownerEmail: 'not-an-email' } },
  { label: 'e-mail acima de 320 caracteres', override: { ownerEmail: `${'a'.repeat(309)}@example.test` } },
  { label: 'senha vazia após trim', override: { ownerPassword: '   ' } },
  { label: 'senha acima de 1024 caracteres', override: { ownerPassword: 'p'.repeat(1025) } },
  { label: 'requestId fora do formato UUID', override: { requestId: 'not-a-uuid' } },
];

describe('createTenant', () => {
  it.each(invalidTenantInputs)(
    'recusa $label antes de transação e hash',
    async ({ override }) => {
      const { dependencies } = baseDependencies();
      let transactionOpened = false;
      let passwordHashed = false;
      const service = createTenantCreator({
        ...dependencies,
        runInAdminTransaction: async () => {
          transactionOpened = true;
          throw new Error('unexpected transaction');
        },
        hashPassword: async () => {
          passwordHashed = true;
          throw new Error('unexpected hash');
        },
      });

      await expect(service({ ...createNewInput(), ...override })).rejects.toMatchObject({
        code: 'INVALID_TENANT_INPUT',
      });
      expect(transactionOpened).toBe(false);
      expect(passwordHashed).toBe(false);
    },
  );

  it('recusa ownerMode desconhecido antes de abrir transação', async () => {
    const { dependencies } = baseDependencies();
    let transactionOpened = false;
    const service = createTenantCreator({
      ...dependencies,
      runInAdminTransaction: async () => {
        transactionOpened = true;
        throw new Error('unexpected transaction');
      },
    });

    await expect(service({
      ...linkExistingInput(),
      ownerMode: 'UNRECOGNIZED_OWNER_MODE',
      confirmLinkExisting: false,
    } as never)).rejects.toMatchObject({ code: 'INVALID_OWNER_MODE' });
    expect(transactionOpened).toBe(false);
  });

  it.each([
    ['', 'ADMINISTRATIVE_CREDENTIAL_REQUIRED'],
    ['wrong-admin-secret-canary', 'ADMINISTRATIVE_CREDENTIAL_INVALID'],
  ])('recusa credencial administrativa local %j antes de abrir transação', async (
    administrativeCredential,
    expectedCode,
  ) => {
    const { dependencies } = baseDependencies();
    let transactionOpened = false;
    const service = createTenantCreator({
      ...dependencies,
      runInAdminTransaction: async () => {
        transactionOpened = true;
        throw new Error('unexpected transaction');
      },
    });

    const rejection = await service({
      ...createNewInput(),
      administrativeCredential,
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: expectedCode });
    if (administrativeCredential.length > 0) {
      expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain(
        administrativeCredential,
      );
    }
    expect(transactionOpened).toBe(false);
  });

  it('só funciona após o bootstrap e não cria dados no banco vazio', async () => {
    const { dependencies } = baseDependencies();
    const writes: string[] = [];
    const service = createTenantCreator({
      ...dependencies,
      countOrganizations: async () => 0,
      createOrganization: async () => { writes.push('organization'); throw new Error('unexpected'); },
      createUser: async () => { writes.push('user'); throw new Error('unexpected'); },
      createOwnerMembership: async () => { writes.push('membership'); },
      ensureLogicalBaileysAccount: async () => {
        writes.push('provider-account');
        throw new Error('unexpected');
      },
      writeTenantAudit: async () => { writes.push('audit'); },
    });

    await expect(service(createNewInput())).rejects.toMatchObject({ code: 'BOOTSTRAP_REQUIRED' });
    expect(writes).toEqual([]);
  });

  it('CREATE_NEW recusa e-mail existente sem fazer hash nem qualquer write', async () => {
    const { dependencies } = baseDependencies();
    const existing = Object.freeze({
      id: '2b096a66-b89c-4e87-90b8-d3353bc482d9',
      email: 'existing@example.test',
      status: 'ACTIVE' as const,
      passwordHash: '$argon2id$original-hash-canary',
    });
    const observed: string[] = [];
    const service = createTenantCreator({
      ...dependencies,
      findUserByEmailForUpdate: async (_tx, email) => {
        observed.push(`find:${email}`);
        return existing;
      },
      hashPassword: async () => { observed.push('hash'); return 'unexpected'; },
      createOrganization: async () => { observed.push('organization'); throw new Error('unexpected'); },
      createUser: async () => { observed.push('user'); throw new Error('unexpected'); },
      createOwnerMembership: async () => { observed.push('membership'); },
      ensureLogicalBaileysAccount: async () => {
        observed.push('provider-account');
        throw new Error('unexpected');
      },
      writeTenantAudit: async () => { observed.push('audit'); },
    });

    const rejection = await service({
      ...createNewInput(),
      ownerEmail: ' Existing@Example.test ',
      ownerPassword: 'replacement-password-canary',
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'OWNER_EMAIL_ALREADY_EXISTS' });
    expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain(
      'replacement-password-canary',
    );
    expect(observed).toEqual(['find:existing@example.test']);
    expect(existing.passwordHash).toBe('$argon2id$original-hash-canary');
  });

  it('LINK_EXISTING exige confirmação antes de verificar credencial ou iniciar efeitos', async () => {
    const { dependencies } = baseDependencies();
    const observed: string[] = [];
    const service = createTenantCreator({
      ...dependencies,
      verifyAdministrativeCredential: async () => { observed.push('verify'); return true; },
      runInAdminTransaction: async () => { observed.push('transaction'); throw new Error('unexpected'); },
      hashPassword: async () => { observed.push('hash'); throw new Error('unexpected'); },
    });

    await expect(service({
      ...linkExistingInput(),
      confirmLinkExisting: false,
    })).rejects.toMatchObject({ code: 'LINK_EXISTING_CONFIRMATION_REQUIRED' });
    expect(observed).toEqual([]);
  });

  it('LINK_EXISTING recusa usuário desativado', async () => {
    const { dependencies } = baseDependencies();
    const service = createTenantCreator({
      ...dependencies,
      findUserByEmailForUpdate: async () => ({
        id: OWNER_ID,
        email: 'existing@example.test',
        status: 'DISABLED' as const,
        passwordHash: '$argon2id$original-hash-canary',
      }),
    });

    await expect(service(linkExistingInput())).rejects.toMatchObject({
      code: 'OWNER_USER_NOT_ACTIVE',
    });
  });

  it('LINK_EXISTING recusa e-mail sem usuário existente', async () => {
    const { dependencies } = baseDependencies();
    const service = createTenantCreator(dependencies);

    await expect(service(linkExistingInput())).rejects.toMatchObject({
      code: 'OWNER_USER_NOT_FOUND',
    });
  });

  it('LINK_EXISTING recusa senha antes de verificar credencial ou iniciar efeitos', async () => {
    const { dependencies } = baseDependencies();
    const observed: string[] = [];
    const service = createTenantCreator({
      ...dependencies,
      verifyAdministrativeCredential: async () => { observed.push('verify'); return true; },
      runInAdminTransaction: async () => { observed.push('transaction'); throw new Error('unexpected'); },
      hashPassword: async () => { observed.push('hash'); throw new Error('unexpected'); },
    });
    const inputWithForbiddenPassword = {
      ...linkExistingInput(),
      ownerPassword: 'forbidden-password-canary',
    } as never;

    await expect(service(inputWithForbiddenPassword)).rejects.toMatchObject({
      code: 'LINK_EXISTING_PASSWORD_NOT_ALLOWED',
    });
    expect(observed).toEqual([]);
  });

  it('LINK_EXISTING reutiliza somente o usuário ativo e preserva seu password_hash', async () => {
    const { dependencies, transaction } = baseDependencies();
    const originalPasswordHash = '$argon2id$original-hash-canary';
    const observed: Array<{ step: string; tx?: FakeTransaction; value?: unknown }> = [];
    const service = createTenantCreator({
      ...dependencies,
      findUserByEmailForUpdate: async (tx, email) => {
        observed.push({ step: 'find', tx, value: email });
        return {
          id: OWNER_ID,
          email,
          status: 'ACTIVE' as const,
          passwordHash: originalPasswordHash,
        };
      },
      hashPassword: async () => { throw new Error('LINK_EXISTING must not hash'); },
      createUser: async () => { throw new Error('LINK_EXISTING must not create user'); },
      createOrganization: async (tx, input) => {
        observed.push({ step: 'organization', tx, value: input });
        return dependencies.createOrganization(tx, input);
      },
      createOwnerMembership: async (tx, input) => {
        observed.push({ step: 'membership', tx, value: input });
      },
      ensureLogicalBaileysAccount: async (tx, organizationId) => {
        observed.push({ step: 'provider-account', tx, value: organizationId });
        return dependencies.ensureLogicalBaileysAccount(tx, organizationId);
      },
      writeTenantAudit: async (tx, event) => {
        observed.push({ step: 'audit', tx, value: event });
      },
    });

    const result = await service(linkExistingInput());

    expect(result).toEqual({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    expect(observed.map(({ step }) => step)).toEqual([
      'find',
      'organization',
      'membership',
      'provider-account',
      'audit',
    ]);
    expect(observed.every(({ tx }) => tx === transaction)).toBe(true);
    expect(JSON.stringify({ result, observed })).not.toContain(originalPasswordHash);
  });

  it('CREATE_NEW retorna e audita somente identificadores, sem credenciais ou hashes', async () => {
    const { dependencies } = baseDependencies();
    const audits: unknown[] = [];
    const service = createTenantCreator({
      ...dependencies,
      writeTenantAudit: async (_tx, event) => { audits.push(event); },
    });

    const result = await service(createNewInput());
    const serializedPublicData = JSON.stringify({ result, audits });

    expect(result).toEqual({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    expect(Object.keys(result).sort()).toEqual([
      'organizationId',
      'ownerUserId',
      'providerAccountId',
    ]);
    expect(audits).toEqual([{
      type: 'TENANT_CREATED',
      organizationId: ORGANIZATION_ID,
      resourceId: ORGANIZATION_ID,
      requestId: REQUEST_ID,
    }]);
    for (const canary of [
      'valid-admin-secret-canary',
      'owner-password-canary',
      '$argon2id$new:',
      'new.owner@example.test',
    ]) {
      expect(serializedPublicData).not.toContain(canary);
    }
  });
});
