import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Trash2 } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

import { ConfirmModal } from '@/components/ui/confirm-modal';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen } from '@/components/ui/screen';
import { StatusBadge } from '@/components/ui/status-badge';
import { Fonts, Spacing } from '@/constants/theme';
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

  const markdownStyles = {
    body: { color: colors.text, fontSize: 15, lineHeight: 23 },
    heading1: { color: colors.text, fontWeight: '700' as const, marginTop: Spacing.four },
    heading2: { color: colors.text, fontWeight: '700' as const, marginTop: Spacing.four },
    heading3: { color: colors.text, fontWeight: '600' as const, marginTop: Spacing.three },
    strong: { color: colors.text, fontWeight: '700' as const },
    bullet_list: { marginVertical: Spacing.two },
    blockquote: {
      backgroundColor: colors.surfaceAlt,
      borderLeftColor: colors.primary,
      borderLeftWidth: 3,
      paddingHorizontal: Spacing.three,
    },
    code_inline: {
      backgroundColor: colors.surfaceAlt,
      color: colors.text,
      fontFamily: Fonts?.mono,
    },
    fence: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border,
      color: colors.text,
      fontFamily: Fonts?.mono,
    },
    table: { borderColor: colors.border },
    th: { color: colors.text },
    tr: { borderColor: colors.border },
    hr: { backgroundColor: colors.border },
  };

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
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.meta}>
            <Text style={[styles.topic, { color: colors.textTertiary }]}>
              Topic: {guide.topic}
              {guide.source_count
                ? ` · built from ${guide.source_count} source${guide.source_count === 1 ? '' : 's'}`
                : ''}
            </Text>
          </View>
          <Markdown style={markdownStyles}>{guide.content ?? ''}</Markdown>
        </ScrollView>
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
  content: {
    paddingBottom: Spacing.six,
  },
  meta: {
    marginBottom: Spacing.two,
  },
  topic: {
    fontSize: 13,
  },
});
