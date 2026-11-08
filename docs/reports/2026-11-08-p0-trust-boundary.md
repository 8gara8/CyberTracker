# P0 trust boundary (SPEC §9.4 P0 verification checklist)

Status: in progress. Times are Taipei (UTC+8), with UTC in brackets.

## How the tasks were made

- 2026-11-08 14:18 (06:18 UTC): `create_trigger` from the build thread refused `connectors: []`
  ("not available for this organization"). Without it, the call made a project routine: each run
  would start a new project thread, use the project's settings instead of `cybertracker-run`, and
  could be neither fired with added text nor changed with `update_trigger`. Deleted unfired.
  SPEC §0.5 records the change to J7.
- 2026-11-08 15:53 to 15:54 (07:53 to 07:54 UTC): JL made `cybertracker-ops` and
  `cybertracker-morning` by hand (J7). Claude switched both off at 15:55 to 15:56 with
  `update_trigger` (`enabled: false`).
- As made, both tasks store every claude.ai connector of the account (`mcp_connections` lists 11), no
  explicit notification setting, and the stored prompts equal `routine/OPS.md` and §9.4's
  `routine/TASK.md` (trailing newline aside).

## Creating session

`get_session()` of the build session: repositories `8gara8/cybertracker` and
`8gara8/cybertracker-content`; environment Default (limited network).

## First `ops: tools` firing (2026-11-08 15:55, 07:55 UTC)

- `fire_trigger` with the text `ops: tools` was accepted by the hand-made task (unlike the project
  routine). The session started in about 2 seconds and replied at 15:56:23, status completed.
- `get_session`: not `cybertracker-run` but a generic cloud environment; no repositories listed;
  tags include push notifications for the routine.
- Final reply (tool names): every claude.ai connector was present and connected (Gmail, Google
  Drive, Google Calendar, Vercel, Claude Docs, Consensus, Hugging Face, Massive, Anthropic Economic
  Index; Microsoft 365 pending), plus a memory server and `create_trigger`, `update_trigger`,
  `delete_trigger`, `fire_trigger`, `send_later`. `add_repo` was not among the session's own tools.
- Verdict: fails "What every fired session must have" on connectors, environment, repositories and
  notifications. Asked JL at once to fix the three settings in both tasks (connectors removed,
  environment `cybertracker-run`, notifications off) and to leave them switched off.

## Still to run

The probe, `agent-check-passthrough` and `agent-check` (after J3 and the task fixes), the code ruleset
check (after J6) and the workflow-file test.
