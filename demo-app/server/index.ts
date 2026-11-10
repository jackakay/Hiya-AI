import express from "express";
import { createServer as createViteServer } from "vite";
import { voiceBug } from "@voice-bug/middleware";

const PORT = Number(process.env.PORT ?? 5173);

type Note = { id: number; name: string; createdAt: string; tags?: string[] };
const notes: Note[] = [{ id: 1, name: "Welcome to Notes", createdAt: new Date().toISOString(), tags: ["intro", "help"] }];
let nextId = 2;

const app = express();
app.use(voiceBug());
app.use(express.json());

app.get("/api/notes", (_req, res) => {
  res.json(notes);
});

app.post("/api/save", (req, res) => {
  const name = req.body.name.trim();
  const note: Note = { id: nextId++, name, createdAt: new Date().toISOString() };
  notes.push(note);
  console.log(`saved note ${note.id}`);
  res.status(201).json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  const index = notes.findIndex((n) => n.id === Number(req.params.id));
  if (index === -1) {
    console.warn(`delete: note ${req.params.id} not found`);
    return res.status(404).json({ error: "Note not found" });
  }
  const [removed] = notes.splice(index, 1);
  console.log(`deleted note ${removed!.id}`);
  res.status(204).end();
});

// Search is backed by a (simulated) slow full-text index.
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").toLowerCase();
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 700));
  res.json(notes.filter((n) => n.name.toLowerCase().includes(q)));
});

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`demo-app running at http://localhost:${PORT}`);
});
