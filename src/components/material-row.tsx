import {
  FileText,
  Globe,
  LucideIcon,
  MoreVertical,
  Music,
  Presentation,
  Table2,
  Video,
} from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StatusBadge } from '@/components/ui/status-badge';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { Material } from '@/lib/types';

function MaterialIcon({
  mimeType,
  size,
  color,
}: {
  mimeType: string;
  size: number;
  color: string;
}) {
  let Icon: LucideIcon = FileText;
  if (mimeType.includes('presentation')) Icon = Presentation;
  else if (mimeType.includes('spreadsheet')) Icon = Table2;
  else if (mimeType === 'text/html') Icon = Globe;
  else if (mimeType.startsWith('audio/')) Icon = Music;
  else if (mimeType.startsWith('video/')) Icon = Video;
  return <Icon size={size} color={color} />;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MaterialRow({
  material,
  onMenu,
}: {
  material: Material;
  onMenu: (material: Material) => void;
}) {
  const colors = useThemeColors();
  const size = formatSize(material.file_size);

  return (
    <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
        <MaterialIcon mimeType={material.mime_type} size={20} color={colors.primary} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {material.title}
        </Text>
        <Text style={[styles.meta, { color: colors.textTertiary }]} numberOfLines={1}>
          {material.file_name}
          {size ? ` · ${size}` : ''}
        </Text>
        {material.status === 'error' && material.error_message ? (
          <Text style={[styles.meta, { color: colors.danger }]} numberOfLines={2}>
            {material.error_message}
          </Text>
        ) : null}
      </View>
      <StatusBadge status={material.status} />
      <Pressable onPress={() => onMenu(material)} hitSlop={8} style={styles.menu}>
        <MoreVertical size={20} color={colors.textSecondary} />
      </Pressable>
    </View>
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
