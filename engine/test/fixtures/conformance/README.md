Stub replies for the FR-15 conformance test (`test/conformance.test.ts`).

`native.*` is what an Anthropic-format endpoint answers to a one-tool
conversation; `translated.*` is the same conversation as an OpenAI-format
endpoint's tool call, as the router must present it (an Anthropic Messages
`tool_use` block). They differ in ids and in how the streamed arguments are
chunked, and must agree in the tool name, the arguments and the stop reason.
Generic prompts only. They are written to the Messages wire format, not
captured from a LiteLLM run, so they test the gateway's path only; a run of the
pinned LiteLLM image against stub endpoints is still needed for full FR-15
conformance (it needs Docker, so it can't be a unit test).
