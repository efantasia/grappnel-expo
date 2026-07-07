import { ChevronRight, Folder as FolderIcon, MoreVertical } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { Folder } from '@/lib/types';

export function FolderRow({
  folder,
  materialCount,
  onPress,
  onMenu,
}: {
  folder: Folder;
  materialCount: number;
  onPress: (folder: Folder) => void;
  onMenu: (folder: Folder) => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => onPress(folder)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.warningSoft }]}>
        <FolderIcon size={20} color={colors.warning} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={[styles.meta, { color: colors.textTertiary }]}>
          {materialCount === 1 ? '1 source' : `${materialCount} sources`}
        </Text>
      </View>
      <Pressable onPress={() => onMenu(folder)} hitSlop={8} style={styles.menu}>
        <MoreVertical size={20} color={colors.textSecondary} />
      </Pressable>
      <ChevronRight size={18} color={colors.textTertiary} />
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
