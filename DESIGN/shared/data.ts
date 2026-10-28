// Completely fictional, local-only design fixtures. No media URLs or network IO.
export type DemoBeat = {
  id: string;
  title: string;
  artist: string;
  tag: "Ambient" | "Trap" | "Electronic";
  bpm: number;
  stars: number; // Fictional 0–5 rating for the lab.
  createdAt: string; // Fictional ISO date.
  key: string;
  duration: string;
  art: "lilac" | "ember" | "ocean" | "silver" | "forest" | "pink";
  monogram: string;
};

export const DEMO_BEATS: readonly DemoBeat[] = [
  { id: "demo-01", title: "Afterimage", artist: "Studio Fiction", tag: "Ambient", bpm: 92, stars: 5, createdAt: "2026-10-20", key: "D minor", duration: "2:42", art: "lilac", monogram: "A" },
  { id: "demo-02", title: "Mirage Radio", artist: "Sample Collective", tag: "Trap", bpm: 142, stars: 3, createdAt: "2026-09-14", key: "F minor", duration: "3:09", art: "ember", monogram: "M" },
  { id: "demo-03", title: "Blue Hour", artist: "Imaginary Sound", tag: "Electronic", bpm: 118, stars: 4, createdAt: "2026-10-26", key: "C major", duration: "2:57", art: "ocean", monogram: "B" },
  { id: "demo-04", title: "Glass Garden", artist: "Studio Fiction", tag: "Ambient", bpm: 76, stars: 2, createdAt: "2026-07-18", key: "A minor", duration: "3:34", art: "silver", monogram: "G" },
  { id: "demo-05", title: "Soft Signal", artist: "Sample Collective", tag: "Electronic", bpm: 124, stars: 5, createdAt: "2026-08-30", key: "E minor", duration: "2:18", art: "forest", monogram: "S" },
  { id: "demo-06", title: "Night Bloom", artist: "Imaginary Sound", tag: "Trap", bpm: 136, stars: 1, createdAt: "2026-10-02", key: "G minor", duration: "3:21", art: "pink", monogram: "N" },
];
