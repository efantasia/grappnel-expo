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

export default function SignupScreen() {
  const colors = useThemeColors();
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    const result = await signUp(email, password, name);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // With email confirmation enabled there is no session yet — tell the user
    // to check their inbox. Otherwise the root layout redirects on session.
    setAwaitingConfirmation(true);
  };

  if (awaitingConfirmation) {
    return (
      <Screen>
        <ScreenHeader title="Check your email" showBack />
        <View style={styles.confirm}>
          <Text style={[styles.confirmText, { color: colors.textSecondary }]}>
            We sent a confirmation link to {email.trim()}. Confirm your address,
            then come back and sign in.
          </Text>
          <Link href="/auth/login" style={[styles.link, { color: colors.primary }]}>
            Go to sign in
          </Link>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Create account" showBack />
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          autoComplete="name"
          placeholder="Your name"
        />
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
          placeholder="At least 8 characters"
          onSubmitEditing={handleSubmit}
        />
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <Button
          title="Create account"
          onPress={handleSubmit}
          loading={submitting}
          disabled={!name.trim() || !email.trim() || password.length < 8}
        />
        <View style={styles.links}>
          <Link href="/auth/login" style={[styles.link, { color: colors.primary }]}>
            Already have an account? Sign in
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
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  link: {
    fontSize: 15,
    fontWeight: '500',
  },
  confirm: {
    gap: Spacing.three,
    paddingTop: Spacing.four,
  },
  confirmText: {
    fontSize: 15,
    lineHeight: 22,
  },
});
