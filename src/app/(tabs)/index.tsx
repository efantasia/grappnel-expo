import { useFocusEffect, useRouter } from 'expo-router';
import { FolderPlus, Inbox, Upload } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FolderRow } from '@/components/folder-row';
import { MaterialActions } from '@/components/material-actions';
import { MaterialRow } from '@/components/material-row';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { OptionsModal } from '@/components/ui/options-modal';
import { PromptModal } from '@/components/ui/prompt-modal';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useIndexingPoll } from '@/hooks/use-indexing-poll';
import { useThemeColors } from '@/hooks/use-theme-colors';
import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from '@/lib/services/folders';
import { listMaterials } from '@/lib/services/materials';
import { pickMaterials, uploadMaterials } from '@/lib/services/upload';
import { Folder, Material } from '@/lib/types';

type FolderMode = 'create' | 'menu' | 'rename' | 'delete' | null;

export default function LibraryScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const { user } = useAuth();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [folderMode, setFolderMode] = useState<FolderMode>(null);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [folderResult, materialResult] = await Promise.all([
      listFolders(),
      listMaterials(),
    ]);
    if (folderResult.data) setFolders(folderResult.data);
    if (materialResult.data) setMaterials(materialResult.data);
    const firstError = folderResult.error ?? materialResult.error;
    if (firstError) setNotice(firstError);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useIndexingPoll(materials, load);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleUpload = async () => {
    if (!user) return;
    const assets = await pickMaterials();
    if (assets.length === 0) return;
    setUploading(true);
    setNotice(null);
    const outcomes = await uploadMaterials(user.id, null, assets);
    setUploading(false);
    const failures = outcomes.filter((o) => o.error);
    if (failures.length > 0) {
      setNotice(
        failures.map((f) => `${f.fileName}: ${f.error}`).join('\n'),
      );
    }
    await load();
  };

  const closeFolderModals = () => {
    setFolderMode(null);
    setSelectedFolder(null);
    setFolderBusy(false);
    setFolderError(null);
  };

  const handleCreateFolder = async (name: string) => {
    setFolderBusy(true);
    setFolderError(null);
    const { error } = await createFolder(name);
    if (error) {
      setFolderBusy(false);
      setFolderError(error);
      return;
    }
    closeFolderModals();
    await load();
  };

  const handleRenameFolder = async (name: string) => {
    if (!selectedFolder) return;
    setFolderBusy(true);
    setFolderError(null);
    const { error } = await renameFolder(selectedFolder.id, name);
    if (error) {
      setFolderBusy(false);
      setFolderError(error);
      return;
    }
    closeFolderModals();
    await load();
  };

  const handleDeleteFolder = async () => {
    if (!selectedFolder) return;
    setFolderBusy(true);
    await deleteFolder(selectedFolder.id);
    closeFolderModals();
    await load();
  };

  const unfiled = materials.filter((m) => m.folder_id === null);
  const countByFolder = new Map<string, number>();
  for (const material of materials) {
    if (material.folder_id) {
      countByFolder.set(
        material.folder_id,
        (countByFolder.get(material.folder_id) ?? 0) + 1,
      );
    }
  }

  const listHeader = (
    <View style={styles.sectionList}>
      {notice ? (
        <Pressable
          onPress={() => setNotice(null)}
          style={[styles.notice, { backgroundColor: colors.dangerSoft }]}
        >
          <Text style={{ color: colors.danger, fontSize: 13 }}>{notice}</Text>
        </Pressable>
      ) : null}
      {uploading ? (
        <View style={[styles.notice, { backgroundColor: colors.primarySoft }]}>
          <Text style={{ color: colors.primary, fontSize: 13 }}>
            Uploading… keep the app open until your files appear below.
          </Text>
        </View>
      ) : null}
      {folders.length > 0 ? (
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          Folders
        </Text>
      ) : null}
      {folders.map((folder) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          materialCount={countByFolder.get(folder.id) ?? 0}
          onPress={(f) => router.push(`/folder/${f.id}`)}
          onMenu={(f) => {
            setSelectedFolder(f);
            setFolderMode('menu');
          }}
        />
      ))}
      {unfiled.length > 0 ? (
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          Not in a folder
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <ScreenHeader
        title="Library"
        right={
          <>
            <Pressable onPress={() => setFolderMode('create')} hitSlop={8}>
              <FolderPlus size={24} color={colors.primary} />
            </Pressable>
            <Pressable onPress={handleUpload} hitSlop={8} disabled={uploading}>
              <Upload size={24} color={uploading ? colors.textTertiary : colors.primary} />
            </Pressable>
          </>
        }
      />
      <FlatList
        data={unfiled}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MaterialRow material={item} onMenu={setSelectedMaterial} />
        )}
        ListHeaderComponent={listHeader}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          folders.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Your library is empty"
              message="Upload textbooks, lecture notes, or slides (PDF, DOCX, PPTX, and more) to start building study guides."
            />
          ) : null
        }
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <MaterialActions
        material={selectedMaterial}
        folders={folders}
        onDismiss={() => setSelectedMaterial(null)}
        onChanged={load}
      />

      <PromptModal
        visible={folderMode === 'create'}
        title="New folder"
        placeholder="e.g. Biology 101"
        confirmTitle="Create"
        loading={folderBusy}
        error={folderError}
        onConfirm={handleCreateFolder}
        onClose={closeFolderModals}
      />
      <OptionsModal
        visible={folderMode === 'menu'}
        title={selectedFolder?.name}
        onClose={closeFolderModals}
        options={[
          { label: 'Rename', onPress: () => setFolderMode('rename') },
          { label: 'Delete', destructive: true, onPress: () => setFolderMode('delete') },
        ]}
      />
      <PromptModal
        visible={folderMode === 'rename'}
        title="Rename folder"
        initialValue={selectedFolder?.name ?? ''}
        loading={folderBusy}
        error={folderError}
        onConfirm={handleRenameFolder}
        onClose={closeFolderModals}
      />
      <ConfirmModal
        visible={folderMode === 'delete'}
        title="Delete folder?"
        message={`Sources inside "${selectedFolder?.name}" won't be deleted — they'll move to "Not in a folder".`}
        confirmTitle="Delete"
        destructive
        loading={folderBusy}
        onConfirm={handleDeleteFolder}
        onClose={closeFolderModals}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionList: {
    gap: Spacing.two,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
  },
  separator: {
    height: Spacing.two,
  },
  listContent: {
    paddingBottom: Spacing.six,
    gap: 0,
  },
  notice: {
    borderRadius: 10,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
});
