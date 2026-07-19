import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { CirclePlay, FileUp } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AddYouTubeModal } from '@/components/add-youtube-modal';
import { MaterialActions } from '@/components/material-actions';
import { MaterialRow } from '@/components/material-row';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useIndexingPoll } from '@/hooks/use-indexing-poll';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { listFolders } from '@/lib/services/folders';
import { listMaterials } from '@/lib/services/materials';
import { pickMaterials, uploadMaterials } from '@/lib/services/upload';
import { Folder, Material } from '@/lib/types';

export default function FolderScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [folder, setFolder] = useState<Folder | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [addingVideo, setAddingVideo] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [folderResult, materialResult] = await Promise.all([
      listFolders(),
      listMaterials(id),
    ]);
    if (folderResult.data) {
      setFolders(folderResult.data);
      setFolder(folderResult.data.find((f) => f.id === id) ?? null);
    }
    if (materialResult.data) setMaterials(materialResult.data);
  }, [id]);

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
    if (!user || !id) return;
    const assets = await pickMaterials();
    if (assets.length === 0) return;
    setUploading(true);
    setNotice(null);
    const outcomes = await uploadMaterials(id, assets);
    setUploading(false);
    const failures = outcomes.filter((o) => o.error);
    if (failures.length > 0) {
      setNotice(failures.map((f) => `${f.fileName}: ${f.error}`).join('\n'));
    }
    await load();
  };

  const readyCount = materials.filter((m) => m.status === 'indexed').length;

  return (
    <Screen>
      <ScreenHeader
        title={folder?.name ?? 'Folder'}
        showBack
        right={
          <>
            <Pressable onPress={() => setAddingVideo(true)} hitSlop={8}>
              <CirclePlay size={24} color={colors.primary} />
            </Pressable>
            <Pressable onPress={handleUpload} hitSlop={8} disabled={uploading}>
              <FileUp size={24} color={uploading ? colors.textTertiary : colors.primary} />
            </Pressable>
          </>
        }
      />
      <FlatList
        data={materials}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MaterialRow material={item} onMenu={setSelectedMaterial} />
        )}
        ListHeaderComponent={
          <View style={styles.header}>
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
            {materials.length > 0 ? (
              <Button
                title="Generate study guide"
                onPress={() =>
                  router.push({ pathname: '/generate', params: { folderId: id } })
                }
                disabled={readyCount === 0}
              />
            ) : null}
            {materials.length > 0 && readyCount === 0 ? (
              <Text style={[styles.hint, { color: colors.textTertiary }]}>
                Sources are still indexing — guide generation unlocks when at
                least one is ready.
              </Text>
            ) : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <EmptyState
            icon={FileUp}
            title="No sources yet"
            message="Upload this course's textbook chapters, lecture notes, or slides — or add a YouTube lecture — to this folder."
          />
        }
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.listContent]}
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

      <AddYouTubeModal
        visible={addingVideo}
        folderId={id ?? null}
        onClose={() => setAddingVideo(false)}
        onAdded={async () => {
          setAddingVideo(false);
          await load();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
  },
  separator: {
    height: Spacing.two,
  },
  listContent: {
    paddingBottom: Spacing.six,
  },
  notice: {
    borderRadius: 10,
    padding: Spacing.three,
  },
});
