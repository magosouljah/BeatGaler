// Fictional design fixtures only. No audio, network access, or real library data.
// Exactly 24 beats: one distinct bundled real cover per beat in "Reales" mode.
export const DEMO_TAGS = ["Ambient", "Trap", "Electronic"] as const;
export type DemoTag = (typeof DEMO_TAGS)[number];

export type DemoBeat = {
  id: string;
  title: string; // One-word fictional beat name.
  artist: string;
  tags: readonly DemoTag[];
  bpm: number;
  stars: number; // Fictional 0–5 rating for the lab.
  createdAt: string;
  key: string;
  duration: string;
  art: "lilac" | "ember" | "ocean" | "silver" | "forest" | "pink";
  monogram: string;
};

// Distinct, fixed combinations: variety across refreshes without shifting
// covers/tags during interaction, filtering, playback or screenshot tests.
export const DEMO_BEATS: readonly DemoBeat[] = [
  { id:"demo-01",title:"Vanta",artist:"Studio Fiction",tags:["Ambient","Trap"],bpm:98,stars:5,createdAt:"2026-10-20",key:"D minor",duration:"2:47",art:"lilac",monogram:"V" },
  { id:"demo-02",title:"Lumen",artist:"Studio Fiction",tags:["Electronic","Ambient"],bpm:116,stars:3,createdAt:"2026-09-14",key:"F minor",duration:"3:12",art:"ember",monogram:"L" },
  { id:"demo-03",title:"Kairo",artist:"Studio Fiction",tags:["Trap"],bpm:144,stars:4,createdAt:"2026-10-26",key:"G minor",duration:"2:57",art:"ocean",monogram:"K" },
  { id:"demo-04",title:"Sable",artist:"Studio Fiction",tags:["Electronic","Trap"],bpm:132,stars:2,createdAt:"2026-07-18",key:"A minor",duration:"3:34",art:"silver",monogram:"S" },
  { id:"demo-05",title:"Echo",artist:"Studio Fiction",tags:["Ambient"],bpm:90,stars:5,createdAt:"2026-08-30",key:"E minor",duration:"2:18",art:"forest",monogram:"E" },
  { id:"demo-06",title:"Fable",artist:"Studio Fiction",tags:["Trap","Ambient","Electronic"],bpm:124,stars:1,createdAt:"2026-10-02",key:"C minor",duration:"3:21",art:"pink",monogram:"F" },
  { id:"demo-07",title:"Drift",artist:"Studio Fiction",tags:["Ambient"],bpm:78,stars:3,createdAt:"2026-10-12",key:"B minor",duration:"2:51",art:"ocean",monogram:"D" },
  { id:"demo-08",title:"Bloom",artist:"Studio Fiction",tags:["Electronic","Ambient"],bpm:105,stars:4,createdAt:"2026-10-05",key:"G major",duration:"3:06",art:"lilac",monogram:"B" },
  { id:"demo-09",title:"Quartz",artist:"Studio Fiction",tags:["Trap","Electronic"],bpm:142,stars:2,createdAt:"2026-06-11",key:"C# minor",duration:"2:39",art:"silver",monogram:"Q" },
  { id:"demo-10",title:"Orbit",artist:"Studio Fiction",tags:["Electronic"],bpm:126,stars:5,createdAt:"2026-09-27",key:"F# minor",duration:"3:18",art:"ember",monogram:"O" },
  { id:"demo-11",title:"Haze",artist:"Studio Fiction",tags:["Ambient","Trap"],bpm:84,stars:3,createdAt:"2026-05-17",key:"A major",duration:"2:55",art:"forest",monogram:"H" },
  { id:"demo-12",title:"Pulse",artist:"Studio Fiction",tags:["Trap","Electronic"],bpm:152,stars:4,createdAt:"2026-10-29",key:"D minor",duration:"2:36",art:"pink",monogram:"P" },
  { id:"demo-13",title:"Frost",artist:"Studio Fiction",tags:["Ambient","Electronic"],bpm:100,stars:1,createdAt:"2026-04-18",key:"E major",duration:"3:08",art:"ocean",monogram:"F" },
  { id:"demo-14",title:"Morrow",artist:"Studio Fiction",tags:["Trap"],bpm:138,stars:4,createdAt:"2026-08-14",key:"G# minor",duration:"2:49",art:"silver",monogram:"M" },
  { id:"demo-15",title:"Nova",artist:"Studio Fiction",tags:["Electronic","Trap"],bpm:136,stars:5,createdAt:"2026-10-23",key:"C minor",duration:"3:25",art:"ember",monogram:"N" },
  { id:"demo-16",title:"Halo",artist:"Studio Fiction",tags:["Ambient","Electronic"],bpm:112,stars:3,createdAt:"2026-07-06",key:"D major",duration:"2:42",art:"lilac",monogram:"H" },
  { id:"demo-17",title:"Prism",artist:"Studio Fiction",tags:["Ambient","Trap","Electronic"],bpm:124,stars:2,createdAt:"2026-10-10",key:"F minor",duration:"3:11",art:"forest",monogram:"P" },
  { id:"demo-18",title:"Abyss",artist:"Studio Fiction",tags:["Trap","Ambient"],bpm:130,stars:4,createdAt:"2026-09-03",key:"B minor",duration:"2:59",art:"pink",monogram:"A" },
  { id:"demo-19",title:"Veil",artist:"Studio Fiction",tags:["Ambient"],bpm:80,stars:2,createdAt:"2026-03-26",key:"G major",duration:"3:05",art:"silver",monogram:"V" },
  { id:"demo-20",title:"Flux",artist:"Studio Fiction",tags:["Electronic"],bpm:120,stars:5,createdAt:"2026-10-31",key:"C major",duration:"2:46",art:"ocean",monogram:"F" },
  { id:"demo-21",title:"Crave",artist:"Studio Fiction",tags:["Trap","Electronic"],bpm:150,stars:3,createdAt:"2026-06-24",key:"A minor",duration:"3:02",art:"ember",monogram:"C" },
  { id:"demo-22",title:"Solace",artist:"Studio Fiction",tags:["Ambient","Trap"],bpm:95,stars:4,createdAt:"2026-08-07",key:"F# minor",duration:"2:38",art:"lilac",monogram:"S" },
  { id:"demo-23",title:"Serein",artist:"Studio Fiction",tags:["Ambient","Electronic"],bpm:92,stars:1,createdAt:"2026-10-15",key:"E minor",duration:"3:24",art:"forest",monogram:"S" },
  { id:"demo-24",title:"Zenith",artist:"Studio Fiction",tags:["Trap","Electronic","Ambient"],bpm:128,stars:5,createdAt:"2026-09-22",key:"D# minor",duration:"2:54",art:"pink",monogram:"Z" },
];
