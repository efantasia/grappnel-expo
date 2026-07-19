import { Layers, MoreVertical } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StatusBadge } from '@/components/ui/status-badge';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { FlashcardDeck } from '@/lib/types';

export function FlashcardDeckRow({
  deck,
  onPress,
  onMenu,
}: {
  deck: FlashcardDeck;
  onPress: (deck: FlashcardDeck) => void;
  onMenu: (deck: FlashcardDeck) => void;
}) {
  const colors = useThemeColors();
  const created = new Date(deck.created_at).toLocaleDateString();
  const meta = [
    created,
    deck.card_count ? `${deck.card_count} card${deck.card_count === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={() => onPress(deck)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
        <Layers size={20} color={colors.primary} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {deck.title}
        </Text>
        <Text style={[styles.meta, { color: colors.textTertiary }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <StatusBadge status={deck.status} />
      <Pressable onPress={() => onMenu(deck)} hitSlop={8} style={styles.menu}>
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
