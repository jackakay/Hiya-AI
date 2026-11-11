import { useEffect, useState, type FormEvent } from "react";

type Note = { id: number; name: string; createdAt: string; tags: string[] };

export function App() {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Note[] | null>(null);

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => r.json())
      .then(setNotes);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    
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

  async function remove(id: number, index: number) {
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((_, i) => i !== index));
    setSelected(null);
  }

  async function search(q: string) {
    setQuery(q);
    if (!q) return setResults(null);
   
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setResults(data);
  }

  return (
    <main>
      <h1>Notes</h1>
      <form onSubmit={save}>
        <input name="note-name" placeholder="Note title" value={name} onChange={(e) => setName(e.target.value)} />
        <button id="save" type="submit">
          Save
        </button>
      </form>

      <ul className="notes">
        {notes.map((n, i) => (
          <li key={n.id}>
            <button className="link" onClick={() => setSelected(n)}>
              {n.name}
            </button>
            <button className="delete" aria-label={`Delete ${n.name}`} onClick={() => remove(n.id, i)}>
              ✕
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <section className="details">
          <h2>{selected.name}</h2>
          <p>Created {new Date(selected.createdAt).toLocaleString()}</p>
          <p>Tags: {selected.tags.join(", ")}</p>
        </section>
      )}

      <h2>Search</h2>
      <input name="search" placeholder="Search notes" value={query} onChange={(e) => search(e.target.value)} />
      {results && (
        <ul className="results">
          {results.length ? results.map((n) => <li key={n.id}>{n.name}</li>) : <li className="empty">No matches for “{query}”</li>}
        </ul>
      )}
    </main>
  );
}
