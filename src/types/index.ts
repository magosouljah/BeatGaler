export interface Beat {
  id: string;
  name: string;
  folder_path: string;
  mp3_path: string;
  wav_path: string | null;
  playback_path: string;   // wav if available, else mp3
  bpm: string;
  key: string;
	needs_resolution: boolean;
  tags: string[];
  rating: number;
  image_base64: string | null;
	image_preview_base64?: string | null;
  image_crop?: { x: number; y: number; w: number; h: number; unit: 'ratio' } | null;
  has_wav: boolean;
  has_stems: boolean;
  /** True only when a real Sample/Samples directory exists. Stems do not count. */
  has_samples: boolean;
  samples_path: string | null;
  has_flp: boolean;
  has_als: boolean;
  stems_path: string | null;
  flp_path: string | null;
  als_path: string | null;
  other_files: string[];   // extra mp3/wav not matching folder name
  color: string;
  color2: string;
  has_loop: boolean;
  loop_path: string | null;
  // Telegram Cloud (Fase 12/17)
  cloud_status?: string | null; // undefined/null == LOCAL, "SYNCED" once uploaded
  telegram_file_id?: string | null;
  telegram_message_id?: number | null;
}

export interface SaveMetaPayload {
  mp3_path: string;
  wav_path: string | null;
  bpm: string;
  key: string;
  tags: string[];
  rating: number;
	image_base64: string | null;
  image_preview_base64?: string | null;
  image_crop?: { x: number; y: number; w: number; h: number; unit: 'ratio' } | null;
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
  file_role: "mp3" | "wav" | "samples" | "stems" | "flp" | "als" | "loop" | "project" | "other";
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
  incomplete_warnings_enabled: boolean;
  custom_cursor_enabled: boolean;
  beatgaler_user_id?: string | null;
  telegram_cloud_connected?: boolean;
  telegram_cloud_username?: string | null;
}

export interface TelegramCloudStatus {
  connected: boolean;
  username: string | null;
}

export type UploadMode = "single" | "bulk";
export type VisualType = "image" | "video";
export type Visibility = "public" | "unlisted" | "private";

export interface UploadTemplate {
  name: string;
  title_template: string;
  description_template: string;
	tags: string[];
}

export interface BeatUploadJob {
  beat: Beat;
  visual_type: VisualType;
  image_base64: string | null;
  image_path: string | null;
  video_path: string | null;
  video_loop: boolean;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  scheduled_at: string | null;
  collaborator: string;
  upload_status: "pending" | "generating" | "uploading" | "done" | "error";
  upload_progress: number;
  error_message?: string;
  upload_result_url?: string;
}

export interface YouTubeChannel {
  id: string;
  name: string;
  avatar_url: string | null;
  connected: boolean;
}

export interface YouTubeUploadPayload {
  audio_path: string;
  image_base64: string | null;
  image_path: string | null;
  video_path: string | null;
  video_loop: boolean;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  scheduled_at: string | null;
}

export interface YouTubeUploadResult {
  video_id: string;
  url: string;
}