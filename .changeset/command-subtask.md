---
"@opencode-ai/core": patch
---

Run commands as subagents again: a command whose agent is subagent-mode now spawns a background child session instead of switching the calling session, and `subtask` selects that behavior explicitly.
