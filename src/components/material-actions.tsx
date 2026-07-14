import React, { useState } from 'react';
import { Linking } from 'react-native';

import { ConfirmModal } from '@/components/ui/confirm-modal';
import { OptionsModal } from '@/components/ui/options-modal';
import { PromptModal } from '@/components/ui/prompt-modal';
import {
  deleteMaterial,
  moveMaterial,
  renameMaterial,
  syncMaterial,
} from '@/lib/services/materials';
import { Folder, Material } from '@/lib/types';

type Mode = 'menu' | 'rename' | 'move' | 'delete' | null;

// Shared "..." menu for a material: rename, move to folder, retry indexing,
// delete. Owns all its modals; the host screen just tracks which material is
// selected and refreshes on change.
export function MaterialActions({
  material,
  folders,
  onDismiss,
  onChanged,
}: {
  material: Material | null;
  folders: Folder[];
  onDismiss: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMode('menu');
    setBusy(false);
    setError(null);
    onDismiss();
  };

  const finish = () => {
    close();
    onChanged();
  };

  if (!material) return null;

  const handleRename = async (title: string) => {
    setBusy(true);
    setError(null);
    const { error: renameError } = await renameMaterial(material.id, title);
    if (renameError) {
      setBusy(false);
      setError(renameError);
      return;
    }
    finish();
  };

  const handleMove = async (folderId: string | null) => {
    setBusy(true);
    const { error: moveError } = await moveMaterial(material.id, folderId);
    if (moveError) setError(moveError);
    finish();
  };

  const handleRetry = async () => {
    close();
    await syncMaterial(material.id);
    onChanged();
  };

  const handleDelete = async () => {
    setBusy(true);
    const { error: deleteError } = await deleteMaterial(material.id);
    if (deleteError) {
      setBusy(false);
      setError(deleteError);
      return;
    }
    finish();
  };

  // 'uploading' is retryable so a row abandoned mid-upload (app closed)
  // resolves to a clear error instead of sitting on "Uploading…" forever.
  const canRetry =
    material.status === 'error' ||
    material.status === 'uploaded' ||
    material.status === 'uploading';

  return (
    <>
      <OptionsModal
        visible={mode === 'menu'}
        title={material.title}
        onClose={close}
        options={[
          ...(material.source_url
            ? [
                {
                  label: 'Open video',
                  onPress: () => {
                    Linking.openURL(material.source_url!);
                    close();
                  },
                },
              ]
            : []),
          { label: 'Rename', onPress: () => setMode('rename') },
          { label: 'Move to folder…', onPress: () => setMode('move') },
          ...(canRetry
            ? [{ label: 'Retry indexing', onPress: handleRetry }]
            : []),
          { label: 'Delete', destructive: true, onPress: () => setMode('delete') },
        ]}
      />
      <PromptModal
        visible={mode === 'rename'}
        title="Rename source"
        initialValue={material.title}
        loading={busy}
        error={error}
        onConfirm={handleRename}
        onClose={close}
      />
      <OptionsModal
        visible={mode === 'move'}
        title="Move to folder"
        onClose={close}
        options={[
          {
            label: 'No folder',
            disabled: material.folder_id === null,
            onPress: () => handleMove(null),
          },
          ...folders.map((folder) => ({
            label: folder.name,
            disabled: folder.id === material.folder_id,
            onPress: () => handleMove(folder.id),
          })),
        ]}
      />
      <ConfirmModal
        visible={mode === 'delete'}
        title="Delete source?"
        message={`"${material.title}" will be removed from your library and search index. This cannot be undone.`}
        confirmTitle="Delete"
        destructive
        loading={busy}
        onConfirm={handleDelete}
        onClose={close}
      />
    </>
  );
}
