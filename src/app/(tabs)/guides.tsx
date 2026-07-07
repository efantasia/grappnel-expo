import { useFocusEffect, useRouter } from 'expo-router';
import { BookOpen, Plus } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';

import { GuideRow } from '@/components/guide-row';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useInterval } from '@/hooks/use-interval';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { deleteGuide, listGuides } from '@/lib/services/guides';
import { StudyGuide } from '@/lib/types';

export default function GuidesScreen() {
  const colors = useThemeColors();
  const router = useRouter();

  const [guides, setGuides] = useState<StudyGuide[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StudyGuide | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await listGuides();
    if (data) setGuides(data);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Refresh while any guide is still generating so statuses settle live.
  const generating = guides.some((g) => g.status === 'generating');
  useInterval(load, generating ? 5000 : null);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    await deleteGuide(pendingDelete.id);
    setDeleting(false);
    setPendingDelete(null);
    await load();
  };

  return (
    <Screen>
      <ScreenHeader
        title="Study guides"
        right={
          <Pressable onPress={() => router.push('/generate')} hitSlop={8}>
            <Plus size={26} color={colors.primary} />
          </Pressable>
        }
      />
      <FlatList
        data={guides}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <GuideRow
            guide={item}
            onPress={(guide) => router.push(`/guide/${guide.id}`)}
            onMenu={setPendingDelete}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <EmptyState
            icon={BookOpen}
            title="No study guides yet"
            message="Pick a topic and Grappnel will build a guide from your uploaded materials."
          />
        }
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <ConfirmModal
        visible={pendingDelete !== null}
        title="Delete study guide?"
        message={`"${pendingDelete?.title}" will be permanently deleted.`}
        confirmTitle="Delete"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  separator: {
    height: Spacing.two,
  },
  listContent: {
    paddingBottom: Spacing.six,
  },
});
