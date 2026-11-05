import express from "express";
import { createServer as createViteServer } from "vite";

const PORT = Number(process.env.PORT ?? 5173);

type Note = { id: number; name: string; createdAt: string };
const notes: Note[] = [];

const app = express();
app.use(express.json());

app.get("/api/notes", (_req, res) => {
  res.json(notes);
});

app.post("/api/save", (req, res) => {
  const name = req.body.name.trim();
  const note: Note = { id: notes.length + 1, name, createdAt: new Date().toISOString() };
  notes.push(note);
  console.log(`saved note ${note.id}`);
  res.status(201).json(note);
});

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`demo-app running at http://localhost:${PORT}`);
});
