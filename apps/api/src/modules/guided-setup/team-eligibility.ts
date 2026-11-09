export function eligibleTeamAgentIds(members: ReadonlyArray<{ id: number }>, agents: ReadonlyArray<{ id: number; inboxMember: boolean }>) {
  const allowed = new Set(agents.filter(agent => agent.inboxMember).map(agent => agent.id));
  return [...new Set(members.map(member => member.id).filter(id => allowed.has(id)))];
}
