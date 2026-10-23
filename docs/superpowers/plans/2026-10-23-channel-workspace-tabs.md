# Connection workspace tabs implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this small UI increment.

**Goal:** Make the canonical connection detail easy to operate by promoting the real instance workspace and grouping existing controls into clear areas.

**Approved design:** The parent approved one navigation in ChannelDetail: overview and connection; WhatsApp settings; operational events; attendance/integration; Flow; history/groups. Use `providerReference.instanceId` for workspace/settings. Meta and CENTRAL only expose supported features. Keep global dashboards/reports and company/admin navigation unchanged. Reuse InstanceWorkspace with a controlled area while preserving its legacy navigation. Keep settings drafts across area changes and mount secondary forms/destructive controls only in their selected area.

**Approach:** A controlled `area` prop on InstanceWorkspace preserves its data/draft state; `null` renders no section. ChannelDetail owns one accessible tablist. Flow binding/catalog and history/groups load on demand. Conversation access links to the existing `/mensagens` screen without unsupported filters.

**Constraints:** UI only: ChannelDetail, InstanceWorkspace, their tests and existing workspace CSS. Preserve QR/reconnect, ownerRevision, no automatic bot selection/activation, role/tenant guards, deletion component props, and other agents' edits. No backend edits, production actions, messages, new dependencies or commits. Focused tests only on the 8 GB host.

- [x] RED: default overview has one navigation and no wizard/binding/catalog/history setup; workspace uses the provider instance ID.
- [x] RED: settings survive tab switches, save explicitly via the existing API and refresh from server; operators/viewers cannot save.
- [x] RED: Meta/CENTRAL do not request instance workspace/settings or expose unsupported actions; Flow preserves explicit selection and expected owner revision.
- [x] Implement controlled InstanceWorkspace areas, conditional detail sections and modest responsive styling.
- [x] Adapt existing detail tests to navigate to the relevant area; retain the legacy workspace tests.
- [x] Run focused web regressions, typecheck and diff check. Record actual results and review limits.

## Execution ledger

- The previous onboarding backend increment is complete and frozen. This plan changes no backend contracts.
- Genuine RED: all seven new component cases failed against the original screen because the connection had no area tabs and rendered the entire setup at once (75.10 seconds, exit 1).
- GREEN: all seven new cases passed after the UI implementation (7.21 seconds, exit 0). The tests use the actual ChannelDetail and InstanceWorkspace under the session/router providers, without booting the global AppShell.
- Regression GREEN: six files / 82 tests passed in 44.56 seconds: ChannelDetail, Channels, legacy InstanceWorkspace, ChannelOperationSetup, HistoryImportPanel and WhatsAppGroups.
- Final component GREEN: ChannelDetail and legacy InstanceWorkspace passed all 14 tests after keyboard focus and empty-state refinements (22.50 seconds, exit 0). Typecheck and `git diff --check` passed on the final UI source.
- The selected published Flow remains an explicit user choice. Its value survives area changes; submission uses the loaded `expectedOwnerRevision` and the existing API. Nothing selects or activates an automation on navigation.
- The tablist supports arrow keys, Home and End. Secondary forms and deletion controls are mounted only in the selected area. The persistent workspace renders no panel for a null controlled area, retaining its draft and tenant-generation/abort guards.
- Meta/CENTRAL tests verify that QR workspace/settings endpoints are never called. The conversation link uses the supported `/mensagens` route without an invented connection filter. Events remain clearly labeled as operations, with no claimed webhook-delivery log.
- Review limits: validated with component DOM/API-contract regressions and TypeScript locally. No browser screenshot comparison, real provider session, production operation, deployment, full global suite, commit or push was performed by this UI increment. The parent owns combined final review/gates after concurrent work stabilizes.
