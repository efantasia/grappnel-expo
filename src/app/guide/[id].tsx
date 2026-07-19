import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Trash2 } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { GuideContent } from '@/components/guide-content';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen } from '@/components/ui/screen';
import { StatusBadge } from '@/components/ui/status-badge';
import { Spacing } from '@/constants/theme';
import { useInterval } from '@/hooks/use-interval';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { deleteGuide, getGuide } from '@/lib/services/guides';
import { StudyGuide } from '@/lib/types';

export default function GuideScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [guide, setGuide] = useState<StudyGuide | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const { data } = await getGuide(id);
    if (data) setGuide(data);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Poll while the guide is generating (the edge function finishes in the
  // background after responding).
  useInterval(load, guide?.status === 'generating' ? 4000 : null);

  const handleDelete = async () => {
    if (!guide) return;
    setDeleting(true);
    await deleteGuide(guide.id);
    setDeleting(false);
    setConfirmDelete(false);
    router.back();
  };

  const meta = guide?.topic
    ? `Topic: ${guide.topic}${
        guide.source_count
          ? ` · built from ${guide.source_count} source${guide.source_count === 1 ? '' : 's'}`
          : ''
      }`
    : undefined;

  return (
    <Screen>
      <ScreenHeader
        title={guide?.title ?? 'Study guide'}
        showBack
        right={
          guide ? (
            <Pressable onPress={() => setConfirmDelete(true)} hitSlop={8}>
              <Trash2 size={22} color={colors.danger} />
            </Pressable>
          ) : null
        }
      />
      {!guide ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : guide.status === 'generating' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            Building your study guide from your sources… this usually takes
            under a minute.
          </Text>
        </View>
      ) : guide.status === 'error' ? (
        <View style={styles.center}>
          <StatusBadge status="error" />
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            {guide.error_message ?? 'Something went wrong generating this guide.'}
          </Text>
        </View>
      ) : (
        <GuideContent content={guide.content ?? ''} meta={meta} />
      )}

      <ConfirmModal
        visible={confirmDelete}
        title="Delete study guide?"
        message={`"${guide?.title}" will be permanently deleted.`}
        confirmTitle="Delete"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  centerText: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 340,
  },
});
