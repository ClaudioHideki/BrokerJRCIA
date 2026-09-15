import { describe, expect, it } from 'vitest';

import { can, type Permission, type Role } from '../../src/http/plugins/authorization.js';

describe('RBAC do backend', () => {
  const expectations: Array<readonly [Role, Permission, boolean]> = [
    ['OWNER', 'instances:read', true],
    ['OWNER', 'instances:connect', true],
    ['OWNER', 'api_keys:manage', true],
    ['OWNER', 'memberships:manage', true],
    ['OWNER', 'memberships:change_owner', true],
    ['ADMIN', 'instances:read', true],
    ['ADMIN', 'instances:connect', true],
    ['ADMIN', 'api_keys:manage', true],
    ['ADMIN', 'memberships:manage', true],
    ['ADMIN', 'memberships:change_owner', false],
    ['OPERATOR', 'instances:read', true],
    ['OPERATOR', 'instances:connect', true],
    ['OPERATOR', 'api_keys:manage', false],
    ['OPERATOR', 'memberships:manage', false],
    ['VIEWER', 'instances:read', true],
    ['VIEWER', 'instances:connect', false],
    ['VIEWER', 'api_keys:manage', false],
  ];

  it.each(expectations)('%s / %s => %s', (role, permission, allowed) => {
    expect(can(role, permission)).toBe(allowed);
  });
});
