import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

// In-screen header (native headers are disabled) so layout is identical on
// native and web.
export function ScreenHeader({
  title,
  showBack = false,
  right,
}: {
  title: string;
  showBack?: boolean;
  right?: React.ReactNode;
}) {
  const colors = useThemeColors();
  const router = useRouter();
  return (
    // Cap + center the header row to match the scroll content beneath it, while
    // Screen itself spans the full window width.
    <View style={styles.cap}>
      <View style={styles.container}>
        {showBack ? (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
            hitSlop={8}
            style={styles.back}
          >
            <ArrowLeft size={24} color={colors.text} />
          </Pressable>
        ) : null}
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.right}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cap: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.three,
    gap: Spacing.two,
    minHeight: 60,
  },
  back: {
    marginRight: Spacing.one,
  },
  title: {
    flex: 1,
    fontSize: 26,
    fontWeight: '700',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
