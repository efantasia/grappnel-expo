import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

// Full-bleed background + safe area. The body spans the whole window width so
// scroll containers inside it (which own their own scrolling on web) capture
// the wheel anywhere across the window; each child caps *its content* to a
// readable width instead — the header via ScreenHeader, scroll/list content via
// the `screenScroll` styles below.
export function Screen({ children }: { children: React.ReactNode }) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      {children}
    </View>
  );
}

// Shared styling for a scrollable region (ScrollView / FlatList / SectionList):
// the scroll node fills the window width (so the wheel works everywhere on web),
// while its content is centered and capped to the readable max width.
export const screenScroll = StyleSheet.create({
  scroll: {
    flex: 1,
    width: '100%',
  },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
  },
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
