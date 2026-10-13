/** PostgreSQL carries definer diagnostics in message and SQLSTATE in code.
 * Only exact private fleet diagnostics are admitted; arbitrary database/provider
 * text is never exposed as an engine error or a retry permission. */
export function normalizeEvolutionDatabaseError(error:unknown):unknown {
 const value=error as {code?:unknown;message?:unknown;uncertain?:unknown};
 if(['P0001','42501'].includes(String(value?.code))&&typeof value.message==='string'&&/^EVOLUTION_ENGINE_[A-Z0-9_]{1,96}$/u.test(value.message))
  return Object.assign(new Error(value.message),{code:value.message,uncertain:value.uncertain===true});
 return error;
}
