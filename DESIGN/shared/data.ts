// Completely fictional, local-only design fixtures. No media URLs or network IO.
export type DemoBeat = {
  id: string;
  title: string;
  artist: string;
  tag: "Ambient" | "Trap" | "Electronic";
  bpm: number;
  key: string;
  duration: string;
  art: "lilac" | "ember" | "ocean" | "silver" | "forest" | "pink";
  monogram: string;
};

export const DEMO_BEATS: readonly DemoBeat[] = [
  { id: "demo-01", title: "Afterimage", artist: "Studio Fiction", tag: "Ambient", bpm: 92, key: "D minor", duration: "2:42", art: "lilac", monogram: "A" },
  { id: "demo-02", title: "Mirage Radio", artist: "Sample Collective", tag: "Trap", bpm: 142, key: "F minor", duration: "3:09", art: "ember", monogram: "M" },
  { id: "demo-03", title: "Blue Hour", artist: "Imaginary Sound", tag: "Electronic", bpm: 118, key: "C major", duration: "2:57", art: "ocean", monogram: "B" },
  { id: "demo-04", title: "Glass Garden", artist: "Studio Fiction", tag: "Ambient", bpm: 76, key: "A minor", duration: "3:34", art: "silver", monogram: "G" },
  { id: "demo-05", title: "Soft Signal", artist: "Sample Collective", tag: "Electronic", bpm: 124, key: "E minor", duration: "2:18", art: "forest", monogram: "S" },
  { id: "demo-06", title: "Night Bloom", artist: "Imaginary Sound", tag: "Trap", bpm: 136, key: "G minor", duration: "3:21", art: "pink", monogram: "N" },
];
