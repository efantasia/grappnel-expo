import React, { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { OptionsModal } from '@/components/ui/options-modal';
import { PromptModal } from '@/components/ui/prompt-modal';
import { Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { downloadFileFromUrl, downloadTextFile } from '@/lib/download';
import {
  deleteMaterial,
  getMaterialDownload,
  getTranscript,
  moveMaterial,
  renameMaterial,
  syncMaterial,
} from '@/lib/services/materials';
import { Folder, Material } from '@/lib/types';

type Mode = 'menu' | 'rename' | 'move' | 'delete' | 'transcript' | 'download' | null;

// Turns a title/filename into a safe, readable filename.
function safeFilename(name: string, fallback: string): string {
  const safe = name.replace(/[^\w.\-() ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return safe || fallback;
}

function transcriptFilename(title: string): string {
  return `${safeFilename(title, 'transcript')} transcript.txt`;
}

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
  const colors = useThemeColors();
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const close = () => {
    setMode('menu');
    setBusy(false);
    setError(null);
    setDownloadError(null);
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

  // Fetches the transcript text, then hands it to the platform download
  // helper (browser download on web, share sheet on native). The progress
  // modal shows progress and any error, so the menu stays mounted throughout.
  const handleDownloadTranscript = async () => {
    setMode('transcript');
    setDownloadError(null);
    const materialId = material.id;
    const filename = transcriptFilename(material.title);
    const { data, error: fetchError } = await getTranscript(materialId);
    if (fetchError || !data) {
      setDownloadError(fetchError ?? 'Could not load the transcript.');
      return;
    }
    try {
      await downloadTextFile(filename, data.transcript);
      close();
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Could not save the transcript.',
      );
    }
  };

  // Mints a signed URL for the original file, then downloads it (browser
  // download on web, download + share sheet on native).
  const handleDownloadFile = async () => {
    setMode('download');
    setDownloadError(null);
    const filename = safeFilename(material.file_name, 'download');
    const { data, error: urlError } = await getMaterialDownload(material.id);
    if (urlError || !data) {
      setDownloadError(urlError ?? 'Could not prepare the download.');
      return;
    }
    try {
      await downloadFileFromUrl(filename, data.url, data.mime_type);
      close();
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'Could not download the file.',
      );
    }
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
          ...(material.source_type === 'upload' && material.gcs_object
            ? [{ label: 'Download file', onPress: handleDownloadFile }]
            : []),
          ...(material.transcript_object
            ? [{ label: 'Download transcript', onPress: handleDownloadTranscript }]
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
      <AppModal
        visible={mode === 'transcript' || mode === 'download'}
        title={mode === 'download' ? 'Download' : 'Transcript'}
        onClose={close}
      >
        {downloadError ? (
          <>
            <Text style={[styles.message, { color: colors.danger }]}>
              {downloadError}
            </Text>
            <Button title="Close" variant="secondary" onPress={close} />
          </>
        ) : (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.message, { color: colors.textSecondary }]}>
              {mode === 'download' ? 'Preparing download…' : 'Preparing transcript…'}
            </Text>
          </View>
        )}
      </AppModal>
    </>
  );
}

const styles = StyleSheet.create({
  message: {
    fontSize: 15,
    lineHeight: 21,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
});
