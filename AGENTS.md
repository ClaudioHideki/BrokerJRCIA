# JRC WhatsApp Broker contributor rules

- Read the approved design and the current phase plan before editing.
- Use TDD for every feature and bug fix.
- Never commit secrets, customer payloads, telephone numbers, or Baileys auth state.
- Preserve all third-party licenses and attributions.
- Do not deploy to production without an explicit approved release task.
- Run `npm test` and review `git diff --check` before every commit.
