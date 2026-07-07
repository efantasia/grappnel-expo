import { useRouter } from 'expo-router';
import { GraduationCap } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

export default function WelcomeScreen() {
  const colors = useThemeColors();
  const router = useRouter();

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.hero}>
          <View style={[styles.logoWrap, { backgroundColor: colors.primarySoft }]}>
            <GraduationCap size={48} color={colors.primary} strokeWidth={1.75} />
          </View>
          <Text style={[styles.name, { color: colors.text }]}>Grappnel</Text>
          <Text style={[styles.tagline, { color: colors.textSecondary }]}>
            Turn your textbooks, lectures, and slides into study guides that
            actually stick.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title="Get started" onPress={() => router.push('/auth/signup')} />
          <Button
            title="I already have an account"
            variant="ghost"
            onPress={() => router.push('/auth/login')}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingVertical: Spacing.six,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  logoWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
  },
  name: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1,
  },
  tagline: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    maxWidth: 320,
  },
  actions: {
    gap: Spacing.two,
    paddingBottom: Spacing.four,
  },
});
