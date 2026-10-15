// Candidate policy for already-resolved SERVER state. This is not an HTTP
// authenticator and must never receive browser-supplied authority/proof data.
export const FLOW_SCOPES = (['flow:read', 'flow:edit', 'flow:publish', 'flow:bind'] as const);
export const FLOW_GUARDED_PATHS = Object.freeze(['listener', 'dispatch', 'resume', 'recovery', 'workflow-turn', 'runner',
  'workflow-runner', 'remote-event', 'remote-resume', 'remote-recovery', 'remote-runner', 'playbook-webhook', 'playbook-resume', 'automation-rule', 'native-reply', 'agent-bot-listener', 'agent-bot-webhook', 'api-bot-actor', 'native-policy-config'] as const);
