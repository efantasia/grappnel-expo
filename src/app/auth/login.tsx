import { Link } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useThemeColors } from '@/hooks/use-theme-colors';

export default function LoginScreen() {
  const colors = useThemeColors();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    const result = await signIn(email, password);
    setSubmitting(false);
    // On success the root layout redirects to the tabs automatically.
    if (result.error) setError(result.error);
  };

  return (
    <Screen>
      <ScreenHeader title="Sign in" showBack />
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@school.edu"
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Your password"
          onSubmitEditing={handleSubmit}
        />
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <Button
          title="Sign in"
          onPress={handleSubmit}
          loading={submitting}
          disabled={!email.trim() || !password}
        />
        <View style={styles.links}>
          <Link href="/auth/reset-password" style={[styles.link, { color: colors.primary }]}>
            Forgot password?
          </Link>
          <Link href="/auth/signup" style={[styles.link, { color: colors.primary }]}>
            Create an account
          </Link>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
    paddingBottom: Spacing.five,
  },
  links: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  link: {
    fontSize: 15,
    fontWeight: '500',
  },
});
