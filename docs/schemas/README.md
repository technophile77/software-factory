# JSON Schemas

One file per JSON format the engine owns (F-020 FR-2, H-0244), written from
the zod schemas in `engine/src/schemas/` by `npm run write-schemas` in
`engine/`. Don't edit them by hand: an engine test fails when a file here
differs from what the script writes.

`agent-report-1` is the stored report; `agent-report-1.<role>` is what each
role's agent returns, without the fields the engine fills (F-020 SR-7).
