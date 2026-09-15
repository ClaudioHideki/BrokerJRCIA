import { describe, expect, it } from 'vitest';

import { createBootstrapFirstTenant } from '../../src/modules/organizations/bootstrap.js';

const ORGANIZATION_ID = '32ef5b88-c703-4de2-ad88-44958c329158';
const OWNER_ID = '234647ec-e695-4ac3-8729-cc119398ce2c';
const PROVIDER_ACCOUNT_ID = '9fc18a5d-8273-47fc-836a-63a42e86df75';
const REQUEST_ID = '7abf88f4-da9e-47cf-95f8-b0528d29edfd';

interface FakeTransaction {
  readonly marker: 'admin-transaction';
}

function baseDependencies() {
  const transaction: FakeTransaction = { marker: 'admin-transaction' };
  return {
    transaction,
    dependencies: {
      hashPassword: async (password: string) => `$argon2id$hashed:${password}`,
      runInAdminTransaction: async <T>(operation: (tx: FakeTransaction) => Promise<T>) =>
        operation(transaction),
      acquireBootstrapLock: async (_tx: FakeTransaction) => undefined,
      countOrganizations: async (_tx: FakeTransaction) => 0,
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
      ) => ({
        id: OWNER_ID,
        email: input.email,
        status: 'ACTIVE' as const,
      }),
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
      writeSecurityAudit: async (
        _tx: FakeTransaction,
        _event: { type: 'BOOTSTRAP_COMPLETED'; requestId: string },
      ) => undefined,
    },
  };
}

function bootstrapInput() {
  return {
    organizationName: 'JRC',
    organizationSlug: 'jrc',
    email: ' Owner@Example.test ',
    password: 'password-canary',
    requestId: REQUEST_ID,
  };
}

const invalidBootstrapInputs: Array<{
  label: string;
  override: Partial<ReturnType<typeof bootstrapInput>>;
}> = [
  { label: 'nome vazio após trim', override: { organizationName: '   ' } },
  { label: 'nome acima de 200 caracteres', override: { organizationName: 'n'.repeat(201) } },
  { label: 'slug vazio após trim', override: { organizationSlug: '   ' } },
  { label: 'slug acima de 100 caracteres', override: { organizationSlug: 's'.repeat(101) } },
  { label: 'e-mail vazio após trim', override: { email: '   ' } },
  { label: 'e-mail malformado', override: { email: 'not-an-email' } },
  { label: 'e-mail acima de 320 caracteres', override: { email: `${'a'.repeat(309)}@example.test` } },
  { label: 'senha vazia após trim', override: { password: '   ' } },
  { label: 'senha acima de 1024 caracteres', override: { password: 'p'.repeat(1025) } },
  { label: 'requestId fora do formato UUID', override: { requestId: 'not-a-uuid' } },
];

describe('bootstrapFirstTenant', () => {
  it.each(invalidBootstrapInputs)(
    'recusa $label antes de transação e hash',
    async ({ override }) => {
      const { dependencies } = baseDependencies();
      let transactionOpened = false;
      let passwordHashed = false;
      const service = createBootstrapFirstTenant({
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

      await expect(service({ ...bootstrapInput(), ...override })).rejects.toMatchObject({
        code: 'INVALID_BOOTSTRAP_INPUT',
      });
      expect(transactionOpened).toBe(false);
      expect(passwordHashed).toBe(false);
    },
  );

  it('cria organização, usuário normalizado, OWNER e BAILEYS sob o mesmo lock/transação', async () => {
    const { dependencies, transaction } = baseDependencies();
    const observed: Array<{ step: string; tx?: FakeTransaction; value?: unknown }> = [];
    const service = createBootstrapFirstTenant({
      ...dependencies,
      acquireBootstrapLock: async (tx) => { observed.push({ step: 'lock', tx }); },
      countOrganizations: async (tx) => {
        observed.push({ step: 'count', tx });
        return 0;
      },
      createOrganization: async (tx, input) => {
        observed.push({ step: 'organization', tx, value: input });
        return dependencies.createOrganization(tx, input);
      },
      createUser: async (tx, input) => {
        observed.push({ step: 'user', tx, value: input });
        return dependencies.createUser(tx, input);
      },
      createOwnerMembership: async (tx, input) => {
        observed.push({ step: 'membership', tx, value: input });
      },
      ensureLogicalBaileysAccount: async (tx, organizationId) => {
        observed.push({ step: 'provider-account', tx, value: organizationId });
        return dependencies.ensureLogicalBaileysAccount(tx, organizationId);
      },
      writeSecurityAudit: async (tx, event) => {
        observed.push({ step: 'audit', tx, value: event });
      },
    });

    const result = await service(bootstrapInput());

    expect(result).toEqual({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    expect(observed.map(({ step }) => step)).toEqual([
      'lock',
      'count',
      'organization',
      'user',
      'membership',
      'provider-account',
      'audit',
    ]);
    expect(observed.every(({ tx }) => tx === transaction)).toBe(true);
    expect(observed.find(({ step }) => step === 'user')?.value).toEqual({
      email: 'owner@example.test',
      passwordHash: '$argon2id$hashed:password-canary',
    });
    expect(observed.find(({ step }) => step === 'audit')?.value).toEqual({
      type: 'BOOTSTRAP_COMPLETED',
      requestId: REQUEST_ID,
    });
  });

  it('retorna somente identificadores públicos e não encaminha senha ou hash à auditoria', async () => {
    const { dependencies } = baseDependencies();
    const audits: unknown[] = [];
    const service = createBootstrapFirstTenant({
      ...dependencies,
      writeSecurityAudit: async (_tx, event) => { audits.push(event); },
    });

    const result = await service(bootstrapInput());
    const serializedPublicData = JSON.stringify({ result, audits });

    expect(Object.keys(result).sort()).toEqual([
      'organizationId',
      'ownerUserId',
      'providerAccountId',
    ]);
    expect(serializedPublicData).not.toContain('password-canary');
    expect(serializedPublicData).not.toContain('hashed:');
    expect(serializedPublicData).not.toContain('owner@example.test');
  });

  it('recusa uma segunda execução depois do lock sem fazer hash nem writes', async () => {
    const { dependencies } = baseDependencies();
    const observed: string[] = [];
    const service = createBootstrapFirstTenant({
      ...dependencies,
      acquireBootstrapLock: async () => { observed.push('lock'); },
      countOrganizations: async () => {
        observed.push('count');
        return 1;
      },
      hashPassword: async () => { observed.push('hash'); return 'unexpected'; },
      createOrganization: async () => { observed.push('organization'); throw new Error('unexpected'); },
      createUser: async () => { observed.push('user'); throw new Error('unexpected'); },
      createOwnerMembership: async () => { observed.push('membership'); },
      ensureLogicalBaileysAccount: async () => {
        observed.push('provider-account');
        throw new Error('unexpected');
      },
      writeSecurityAudit: async () => { observed.push('audit'); },
    });

    const rejection = await service({
      ...bootstrapInput(),
      organizationName: 'Second',
      organizationSlug: 'second',
      email: 'second@example.test',
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
    expect(`${String(rejection)} ${JSON.stringify(rejection)}`).not.toContain('password-canary');
    expect(observed).toEqual(['lock', 'count']);
  });
});
