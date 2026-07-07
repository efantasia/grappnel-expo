import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { OptionsModal } from '@/components/ui/options-modal';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { listFolders } from '@/lib/services/folders';
import { generateGuide } from '@/lib/services/guides';
import { Folder } from '@/lib/types';

export default function GenerateScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ folderId?: string }>();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(params.folderId ?? null);
  const [topic, setTopic] = useState('');
  const [title, setTitle] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      listFolders().then(({ data }) => {
        if (data) setFolders(data);
      });
    }, []),
  );

  const handleGenerate = async () => {
    setError(null);
    setSubmitting(true);
    const { data, error: generateError } = await generateGuide({
      topic,
      title: title.trim() || undefined,
      folderId,
    });
    setSubmitting(false);
    if (generateError || !data) {
      setError(generateError ?? 'Could not start generation');
      return;
    }
    router.replace(`/guide/${data.id}`);
  };

  const folderName = folderId
    ? (folders.find((f) => f.id === folderId)?.name ?? 'Folder')
    : 'All my materials';

  return (
    <Screen>
      <ScreenHeader title="New study guide" showBack />
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={[styles.help, { color: colors.textSecondary }]}>
          Tell Grappnel what to cover and which sources to use. The guide is
          built only from your uploaded materials.
        </Text>
        <TextField
          label="Topic"
          value={topic}
          onChangeText={setTopic}
          placeholder="e.g. Photosynthesis light reactions, Chapters 4-6, Midterm 2 review"
          multiline
          numberOfLines={3}
          style={styles.topicInput}
        />
        <TextField
          label="Guide title (optional)"
          value={title}
          onChangeText={setTitle}
          placeholder="Defaults to the topic"
        />
        <Text style={[styles.label, { color: colors.textSecondary }]}>Sources</Text>
        <Pressable
          onPress={() => setPickerOpen(true)}
          style={[
            styles.picker,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Text style={{ color: colors.text, fontSize: 16 }}>{folderName}</Text>
          <ChevronDown size={18} color={colors.textSecondary} />
        </Pressable>
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <Button
          title="Generate study guide"
          onPress={handleGenerate}
          loading={submitting}
          disabled={!topic.trim()}
        />
      </ScrollView>

      <OptionsModal
        visible={pickerOpen}
        title="Use sources from"
        onClose={() => setPickerOpen(false)}
        options={[
          {
            label: 'All my materials',
            onPress: () => {
              setFolderId(null);
              setPickerOpen(false);
            },
          },
          ...folders.map((folder) => ({
            label: folder.name,
            onPress: () => {
              setFolderId(folder.id);
              setPickerOpen(false);
            },
          })),
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
    paddingBottom: Spacing.five,
  },
  help: {
    fontSize: 14,
    lineHeight: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  topicInput: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    minHeight: 48,
  },
});
