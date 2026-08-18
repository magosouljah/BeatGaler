import React, { useState } from "react";

type TrashBeat = {
  id: string;
  name: string;
};

const initialTrash: TrashBeat[] = [
  { id: "restore-beat", name: "E2E Restore Beat" },
];

export default function E2ETrashHarness() {
  const [trash, setTrash] = useState<TrashBeat[]>(initialTrash);
  const [library, setLibrary] = useState<TrashBeat[]>([]);
  const [online, setOnline] = useState(true);

  const restore = (beat: TrashBeat) => {
    setTrash(items => items.filter(item => item.id !== beat.id));
    setLibrary(items => [...items, beat]);
  };

  const seedPurgeBeat = () => {
    setTrash([{ id: "purge-beat", name: "E2E Purge Beat" }]);
  };

  const emptyTrash = () => {
    if (!online) return;
    setTrash([]);
  };

  return (
    <div
      data-e2e-trash-harness="true"
      data-e2e-online={online ? "true" : "false"}
      data-e2e-trash-count={String(trash.length)}
      data-e2e-library-count={String(library.length)}
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#ddd",
        padding: 28,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 20 }}>Trash</h1>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, marginBottom: 10 }}>Beats</h2>

        {trash.length === 0 ? (
          <div data-e2e-trash-empty="true">Trash is empty</div>
        ) : (
          trash.map(beat => (
            <div
              key={beat.id}
              data-e2e-trash-item={beat.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <span>{beat.name}</span>

              <button
                data-e2e-restore={beat.id}
                onClick={() => restore(beat)}
              >
                Restore
              </button>
            </div>
          ))
        )}

        <button
          data-e2e-empty-trash="true"
          disabled={!online || trash.length === 0}
          title={!online ? "Internet connection required" : undefined}
          onClick={emptyTrash}
          style={{ marginTop: 14 }}
        >
          Empty beat trash
        </button>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, marginBottom: 10 }}>Library</h2>

        {library.length === 0 ? (
          <div data-e2e-library-empty="true">Library is empty</div>
        ) : (
          library.map(beat => (
            <div key={beat.id} data-e2e-library-item={beat.id}>
              {beat.name}
            </div>
          ))
        )}
      </section>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          data-e2e-toggle-network="true"
          onClick={() => setOnline(value => !value)}
        >
          {online ? "Go offline" : "Go online"}
        </button>

        <button
          data-e2e-seed-purge="true"
          onClick={seedPurgeBeat}
        >
          Seed purge beat
        </button>
      </div>
    </div>
  );
}
