import { useCallback, useState } from "react";
import type { Beat } from "../../types";

type UploadState = { initialBeat: Beat | null; selectedIds?: string[] } | null;

type PublishingActionsOptions = {
  selectedIds: ReadonlySet<string>;
  rejectOfflineMutation: (action: string) => boolean;
};

export function usePublishingActions({ selectedIds, rejectOfflineMutation }: PublishingActionsOptions) {
  const [showUpload, setShowUpload] = useState<UploadState>(null);

  const handleUpload = useCallback((beat: Beat) => {
    if (rejectOfflineMutation("Uploading to YouTube")) return;
    setShowUpload({ initialBeat: beat, selectedIds: undefined });
  }, [rejectOfflineMutation]);

  const handleUploadBulk = useCallback(() => {
    if (rejectOfflineMutation("Bulk upload")) return;
    setShowUpload({ initialBeat: null, selectedIds: Array.from(selectedIds) });
  }, [selectedIds, rejectOfflineMutation]);

  return { showUpload, setShowUpload, handleUpload, handleUploadBulk };
}
