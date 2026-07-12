import React, { useState } from 'react';

import { PromptModal } from '@/components/ui/prompt-modal';
import { addYouTubeMaterial } from '@/lib/services/materials';

// Link-entry modal for adding a YouTube lecture/video as a material. Owns
// the request state; the host screen closes it and refreshes via onAdded.
export function AddYouTubeModal({
  visible,
  folderId,
  onClose,
  onAdded,
}: {
  visible: boolean;
  folderId: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setBusy(false);
    setError(null);
    onClose();
  };

  const handleConfirm = async (url: string) => {
    setBusy(true);
    setError(null);
    const { error: addError } = await addYouTubeMaterial(url, folderId);
    if (addError) {
      setBusy(false);
      setError(addError);
      return;
    }
    setBusy(false);
    setError(null);
    onAdded();
  };

  return (
    <PromptModal
      visible={visible}
      title="Add YouTube video"
      placeholder="https://www.youtube.com/watch?v=…"
      confirmTitle="Add"
      loading={busy}
      error={error}
      inputProps={{
        autoCapitalize: 'none',
        autoCorrect: false,
        keyboardType: 'url',
        inputMode: 'url',
      }}
      onConfirm={handleConfirm}
      onClose={close}
    />
  );
}
