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
   nothing visibly happens. *Say:* "That's a bug, save did nothing."
2. **Blank page on click** (frontend-only crash): save a note, then click its
   title. The frontend `Note` type promises `tags: string[]`, but the server
   only sets `tags` on the seeded note. Rendering the details calls
   `selected.tags.join()` on `undefined`, and React unmounts the whole app.
   There's no backend error at all; the evidence is an `uncaught-error` with
   a browser stack. *Say:* "That's a bug, the page went blank when I opened the note."
3. **Delete lies** (wrong status handling): click ✕ next to a note. The
   frontend sends the list **index** instead of the note id
   (`/api/notes/0` for the first note), gets a 404, ignores the status, and
   removes the row anyway. Reload and the note is back. With two or more notes
   it can even delete a different note. *Say:* "That's a bug, I deleted the
   note but it came back after reloading."
4. **Search race** (race condition): type quickly in Search, e.g. "w", "we",
   "wel". `/api/search` takes 100–800ms at random, and the frontend shows
   whichever response arrives last, not the one for the latest query. So the
   list can show results for "w" while the box says "wel". *Say:* "That's a
   bug, search results don't match what I typed."
