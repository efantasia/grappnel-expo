import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
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
import { listTopics, toTopicSuggestions, TopicSuggestion } from '@/lib/services/topics';
import { Folder } from '@/lib/types';

const MAX_TOPIC_SUGGESTIONS = 12;

export default function GenerateScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ folderId?: string; topic?: string }>();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(params.folderId ?? null);
  const [topic, setTopic] = useState(params.topic ?? '');
  const [title, setTitle] = useState('');
  const [suggestions, setSuggestions] = useState<TopicSuggestion[]>([]);
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

  // Topics Gemini extracted from the selected sources, offered as one-tap
  // starting points for the guide topic.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      listTopics(folderId).then(({ data }) => {
        if (!cancelled) setSuggestions(toTopicSuggestions(data ?? []));
      });
      return () => {
        cancelled = true;
      };
    }, [folderId]),
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
        {suggestions.length > 0 ? (
          <>
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Topics found in your materials
            </Text>
            <View style={styles.chips}>
              {suggestions.slice(0, MAX_TOPIC_SUGGESTIONS).map((suggestion) => {
                const selected = topic === suggestion.name;
                return (
                  <Pressable
                    key={suggestion.name}
                    onPress={() => setTopic(suggestion.name)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: selected ? colors.primarySoft : colors.surface,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={{ color: selected ? colors.primary : colors.text, fontSize: 14 }}>
                      {suggestion.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}
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
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
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
