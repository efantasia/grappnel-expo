import { BookOpen, MoreVertical } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StatusBadge } from '@/components/ui/status-badge';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { StudyGuide } from '@/lib/types';

export function GuideRow({
  guide,
  onPress,
  onMenu,
}: {
  guide: StudyGuide;
  onPress: (guide: StudyGuide) => void;
  onMenu: (guide: StudyGuide) => void;
}) {
  const colors = useThemeColors();
  const created = new Date(guide.created_at).toLocaleDateString();
  return (
    <Pressable
      onPress={() => onPress(guide)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.successSoft }]}>
        <BookOpen size={20} color={colors.success} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {guide.title}
        </Text>
        <Text style={[styles.meta, { color: colors.textTertiary }]} numberOfLines={1}>
          {created}
          {guide.source_count ? ` · ${guide.source_count} source${guide.source_count === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
      <StatusBadge status={guide.status} />
      <Pressable onPress={() => onMenu(guide)} hitSlop={8} style={styles.menu}>
        <MoreVertical size={20} color={colors.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
  },
  menu: {
    padding: 2,
  },
});
