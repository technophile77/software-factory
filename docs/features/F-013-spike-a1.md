# F-013 A-1 spike: Claude Code through LiteLLM to the owner's LAN server

- **Date:** 2026-11-13
- **Result:** **Fails as-is.** Per A-1, the spec goes back to the owner
  (OQ-10).
- **Setup:** LiteLLM 1.106.4 (`litellm-non_root`, pinned by index digest
  `sha256:ee5cb38e…0fd8`; released before the October compromise and more
  than 14 days old; cosign signature not checked because cosign isn't
  installed on the PC), read-only file system, all capabilities dropped,
  bound to 127.0.0.1, no secrets inside. Two routes to the owner's
  `llama-server` (Qwen3.8-27B): Anthropic format and OpenAI format. Claude
  Code 2.1.312 in an empty folder with a throwaway config directory, asked to
  write one file. Only generic prompts were sent; no project data.

## Results
| Test | Anthropic route | OpenAI route |
|---|---|---|
| Direct tool call through LiteLLM, unstreamed | Pass (1.5 s) | Pass (4.3 s) |
| Direct tool call through LiteLLM, streamed | Pass (1.5 s) | Pass (2.4 s) |
| Claude Code, one-file task | **Fail**: HTTP 500 on the first request | **Fail**: same |
| Claude Code straight to `llama-server`, no LiteLLM | **Fail**: same | not tried |

## Cause
Claude Code's request has a `system` block at the top and also a message
with role `system` after the first user message (captured locally:
`messages` = user, system). The Qwen chat template on the server raises
"System message must be at the beginning" for any system message that isn't
first. So the problem is between Claude Code and this model's template, not
LiteLLM: it fails the same way without LiteLLM.

LiteLLM's older `supports_system_message: false` setting didn't help on
1.106.4. LiteLLM documents a newer `model_info.supports_mid_conversation_system:
false` that moves later system messages to the top, available from 1.109.0
([docs](https://docs.litellm.ai/docs/completion/developer_role)). 1.109.0 was
released on 11 November, so under SR-17 it can't be adopted before about 25
November. It wasn't tried.

## Options (OQ-10)
1. Wait for LiteLLM 1.109.x to clear its 14-day quarantine, then re-run this
   spike with `supports_mid_conversation_system: false`. No factory code;
   about 12 days' wait.
2. Change the server: start `llama-server` with a chat template that accepts
   later system messages (`--chat-template-file`). Works now for this server,
   but every endpoint with a strict template would need the same.
3. The factory gateway folds later system messages into the next user
   message before passing a request on. A small transform in our own code
   that works for any endpoint, at the cost of code the owner preferred not
   to write.
4. Run the spike now on LiteLLM 1.109.1 as a one-off exception to the
   quarantine (no secrets, local only), to learn whether option 1 works.

## Re-run on LiteLLM 1.109.1 (owner-approved quarantine exception, 2026-11-13)

The owner picked OQ-10 (d) and approved, in the thread, running container
`f013-litellm-spike109` from `litellm-non_root` 1.109.1 (index digest
`sha256:e9e15fe1…6daba`), with the same lockdown and no secrets. It took
about 8 minutes to start under the read-only file system. The container was
removed afterwards.

| Test | Anthropic route | OpenAI route |
|---|---|---|
| Claude Code, one-file task, with `model_info.supports_mid_conversation_system: false` | **Fail**: same HTTP 500 | **Fail**: same HTTP 500 |

So LiteLLM's setting doesn't reach this case: it is documented for
`developer` messages, and Claude Code's mid-conversation message has role
`system`.

**What does work:** the captured Claude Code request, with the later
`system` message's text appended to the top-level `system` blocks and the
message removed, sent straight to the owner's server: HTTP 200 in 133 s
(15,604 prompt tokens), and the model answered with a correct `Write` tool
call for the requested file. That is option 3 above, the gateway folding
later system messages, and it doesn't depend on LiteLLM or the server's
template.
