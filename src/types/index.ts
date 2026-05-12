export interface Beat {
  id: string;
  name: string;
  folder_path: string;
  mp3_path: string;
  wav_path: string | null;
  playback_path: string;   // wav if available, else mp3
  bpm: string;
  key: string;
  tags: string[];
  rating: number;
  image_base64: string | null;
  has_wav: boolean;
  has_stems: boolean;
  has_flp: boolean;
  has_als: boolean;
  stems_path: string | null;
  flp_path: string | null;
  als_path: string | null;
  other_files: string[];   // extra mp3/wav not matching folder name
  color: string;
  color2: string;
}

export interface SaveMetaPayload {
  mp3_path: string;
  wav_path: string | null;
  bpm: string;
  key: string;
  tags: string[];
  rating: number;
  image_base64: string | null;
  update_filename: boolean;
}

export interface RenamePayload {
  mp3_path: string;
  folder_path: string;
  new_name: string;
}

export interface RenameResult {
  new_folder_path: string;
  new_mp3_path: string;
  new_wav_path: string | null;
  new_stems_path: string | null;
  new_flp_path: string | null;
}

export interface FolderScanResult {
  needs_resolution: boolean;
  mp3_files: string[];
  wav_files: string[];
  stems_files: string[];
  flp_files: string[];
  beat: Beat | null;
}

export interface ResolveFilesPayload {
  folder_path: string;
  mp3_path: string;
  wav_path: string | null;
  stems_path: string | null;
  flp_path: string | null;
}

export interface AddFilePayload {
  beat_folder: string;
  file_path: string;
  file_role: "mp3" | "wav" | "stems" | "flp" | "als";
  beat_name: string;
  bpm: string;
  key: string;
}

export interface SaveMetaResult {
  new_mp3_path: string;
  new_wav_path: string | null;
}

export interface AppSettings {
  beats_folder: string | null;
}
