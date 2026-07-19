import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/ui/button';
import { Screen, screenScroll } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useThemeColors } from '@/hooks/use-theme-colors';

// Two-step reset: email -> 6-digit recovery code + new password. Uses OTP
// verification (no deep links), so it works identically on native and web.
export default function ResetPasswordScreen() {
  const colors = useThemeColors();
  const { sendPasswordReset, resetPasswordWithCode } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSend = async () => {
    setError(null);
    setSubmitting(true);
    const result = await sendPasswordReset(email);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setStep('code');
  };

  const handleReset = async () => {
    setError(null);
    setSubmitting(true);
    const result = await resetPasswordWithCode(email, code, password);
    setSubmitting(false);
    // On success verifyOtp created a session; the root layout redirects.
    if (result.error) setError(result.error);
  };

  return (
    <Screen>
      <ScreenHeader title="Reset password" showBack />
      <ScrollView
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.form]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 'email' ? (
          <>
            <Text style={[styles.help, { color: colors.textSecondary }]}>
              Enter your account email and we&apos;ll send you a recovery code.
            </Text>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="you@school.edu"
            />
            {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
            <Button
              title="Send recovery code"
              onPress={handleSend}
              loading={submitting}
              disabled={!email.trim()}
            />
          </>
        ) : (
          <>
            <Text style={[styles.help, { color: colors.textSecondary }]}>
              We sent a recovery code to {email.trim()}. Enter it below with
              your new password.
            </Text>
            <TextField
              label="Recovery code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              placeholder="6-digit code"
            />
            <TextField
              label="New password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="At least 8 characters"
            />
            {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
            <Button
              title="Reset password"
              onPress={handleReset}
              loading={submitting}
              disabled={code.trim().length < 6 || password.length < 8}
            />
            <Button title="Resend code" variant="ghost" onPress={handleSend} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
    paddingBottom: Spacing.five,
  },
  help: {
    fontSize: 15,
    lineHeight: 22,
  },
});
