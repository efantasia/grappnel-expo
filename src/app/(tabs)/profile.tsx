import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { supabase } from '@/lib/supabase';

export default function ProfileScreen() {
  const colors = useThemeColors();
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        if (data?.display_name) setDisplayName(data.display_name);
      });
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ display_name: displayName.trim() || null })
      .eq('id', user.id);
    setSaving(false);
    if (updateError) setError(updateError.message);
    else setSaved(true);
  };

  return (
    <Screen>
      <ScreenHeader title="Profile" />
      <ScrollView
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.content]}
      >
        <View
          style={[
            styles.card,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.cardLabel, { color: colors.textTertiary }]}>
            Signed in as
          </Text>
          <Text style={[styles.email, { color: colors.text }]}>{user?.email}</Text>
        </View>

        <TextField
          label="Display name"
          value={displayName}
          onChangeText={(value) => {
            setDisplayName(value);
            setSaved(false);
          }}
          placeholder="Your name"
          error={error}
        />
        <Button title={saved ? 'Saved' : 'Save'} onPress={handleSave} loading={saving} />

        <View style={styles.footer}>
          <Button title="Sign out" variant="secondary" onPress={signOut} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  email: {
    fontSize: 16,
    fontWeight: '500',
  },
  footer: {
    marginTop: Spacing.five,
  },
});
