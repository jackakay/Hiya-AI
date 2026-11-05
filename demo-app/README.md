# demo-app

A deliberately buggy notes app used to demo Voice Bug Reporter. One process
(Express + Vite middleware), so the extension can own all of its output.

```bash
pnpm --filter demo-app dev   # http://localhost:5173
```

## Planted bugs (spoilers — kept out of the source on purpose)

The diagnosis step reads source files around stack frames, so bug hints live
here rather than in code comments.

1. **Empty save** — submit the form with an empty title. The frontend sends
   `{}`; `POST /api/save` calls `.trim()` on `undefined` and returns 500 with a
   `TypeError` in the backend log. The frontend ignores non-OK responses, so
   nothing visibly happens.
