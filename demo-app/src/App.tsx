import { useEffect, useState, type FormEvent } from "react";

type Note = { id: number; name: string; createdAt: string };

export function App() {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => r.json())
      .then(setNotes);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    });
    if (res.ok) {
      const note: Note = await res.json();
      setNotes((prev) => [...prev, note]);
      setName("");
    }
  }

  return (
    <main>
      <h1>Notes</h1>
      <form onSubmit={save}>
        <input
          name="note-name"
          placeholder="Note title"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button id="save" type="submit">
          Save
        </button>
      </form>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>{n.name}</li>
        ))}
      </ul>
    </main>
  );
}
