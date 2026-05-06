This Claude Code session is ending and a structured changelog is being written.
Produce a concise markdown summary of what happened. It will be saved to
`.touchgrass/sessions/<id>.md` so the user can resume context later from a fresh
Claude Code instance at their desk.

Output exactly these four sections, in this order, with the headings shown:

## Summary
A 3-6 bullet list of what was investigated, decided, or changed.

## Files touched
List every file that was read, written, or edited. One per line as a markdown
bullet, full path relative to the project root.

## Open threads
Anything left unresolved — failing tests, TODO comments, questions for the user,
half-applied changes. Bullet list. Empty bullet list if nothing applies.

## Next steps
What you'd suggest the user do first when they sit back down. Bullet list.

Rules:
- Keep total length under 400 words. Brevity matters more than completeness.
- Don't include the goal or status — the harness templates those at the top.
- Don't preface with "Here is a summary…" — output the four sections directly.
- Don't include any code blocks longer than 2 lines.
