import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Radius } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { GuideStatus, MaterialStatus } from '@/lib/types';

const LABELS: Record<MaterialStatus | GuideStatus, string> = {
  uploaded: 'Queued',
  syncing: 'Syncing…',
  indexing: 'Indexing…',
  indexed: 'Ready',
  generating: 'Generating…',
  complete: 'Ready',
  error: 'Error',
};

export function StatusBadge({ status }: { status: MaterialStatus | GuideStatus }) {
  const colors = useThemeColors();
  const palette =
    status === 'indexed' || status === 'complete'
      ? { bg: colors.successSoft, fg: colors.success }
      : status === 'error'
        ? { bg: colors.dangerSoft, fg: colors.danger }
        : { bg: colors.warningSoft, fg: colors.warning };

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.label, { color: palette.fg }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
});
