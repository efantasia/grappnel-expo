import { Link, Stack } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

export default function NotFoundScreen() {
  const colors = useThemeColors();
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen>
        <View style={styles.container}>
          <Text style={[styles.title, { color: colors.text }]}>
            This page doesn&apos;t exist.
          </Text>
          <Link href="/(tabs)" style={[styles.link, { color: colors.primary }]}>
            Back to your library
          </Link>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
  link: {
    fontSize: 15,
    fontWeight: '500',
  },
});
