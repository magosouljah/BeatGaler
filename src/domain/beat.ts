export type BeatId = string;

export type ImageCrop = {
  x: number;
  y: number;
  w: number;
  h: number;
  unit: "ratio";
};

/** Platform-neutral beat data shared by Desktop and Web. */
export interface BeatCore {
  id: BeatId;
  name: string;
  bpm: string;
  key: string;
  tags: string[];
  rating: number;
  color: string;
  color2: string;
  needs_resolution: boolean;
  artwork_data_url: string | null;
  artwork_preview_data_url?: string | null;
  artwork_crop?: ImageCrop | null;
}

/** Local paths exist only in the Desktop adapter. */
export interface DesktopBeatSources {
  folder_path: string;
  mp3_path: string;
  wav_path: string | null;
  playback_path: string;
  samples_path: string | null;
  stems_path: string | null;
  flp_path: string | null;
  als_path: string | null;
  loop_path: string | null;
  other_files: string[];
}

/** Opaque Galer Cloud reference. Provider-specific identifiers stay behind adapters. */
export interface GalerCloudObjectRef {
  object_id: string;
  revision?: string | null;
  filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
}

export interface BeatAssets {
  master: GalerCloudObjectRef | null;
  wav: GalerCloudObjectRef | null;
  artwork: GalerCloudObjectRef | null;
  project: GalerCloudObjectRef | null;
  samples: GalerCloudObjectRef | null;
  stems: GalerCloudObjectRef | null;
  loop: GalerCloudObjectRef | null;
}

/** Canonical record targeted by the Web migration. */
export interface BeatRecord extends BeatCore {
  assets: BeatAssets;
  desktop_sources?: DesktopBeatSources;
  offline_available?: boolean;
  sync_status?: string | null;
}
