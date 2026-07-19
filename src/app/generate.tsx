import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Check, ChevronDown } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
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
import { Screen, screenScroll } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { listFolders } from '@/lib/services/folders';
import { generateFlashcards } from '@/lib/services/flashcards';
import { generateGuide } from '@/lib/services/guides';
import {
  aggregateTopics,
  groupTopics,
  listTopics,
  TopicGroup,
} from '@/lib/services/topics';
import { Folder } from '@/lib/types';

export default function GenerateScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ folderId?: string; topic?: string; mode?: string }>();
  const isDeck = params.mode === 'flashcards';

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(params.folderId ?? null);
  // Topics chosen from the suggestion chips (multi-select) plus an optional
  // free-text topic; both are combined when the guide is generated.
  const [selectedTopics, setSelectedTopics] = useState<string[]>(
    params.topic ? [params.topic] : [],
  );
  const [customTopic, setCustomTopic] = useState('');
  const [title, setTitle] = useState('');
  const [topicGroups, setTopicGroups] = useState<TopicGroup[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleTopic = (name: string) => {
    setSelectedTopics((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  };

  // Any selected topic that isn't in the grouped suggestions (e.g. one
  // deep-linked in from the topic detail screen) still renders as a selected
  // chip, above the groups.
  const extraTopics = useMemo(() => {
    const names = new Set(
      topicGroups.flatMap((group) => group.topics.map((topic) => topic.name)),
    );
    return selectedTopics.filter((t) => !names.has(t));
  }, [topicGroups, selectedTopics]);

  const hasTopicChips = topicGroups.length > 0 || extraTopics.length > 0;

  const topics = useMemo(() => {
    const custom = customTopic.trim();
    return [...new Set(custom ? [...selectedTopics, custom] : selectedTopics)];
  }, [selectedTopics, customTopic]);

  useFocusEffect(
    useCallback(() => {
      listFolders().then(({ data }) => {
        if (data) setFolders(data);
      });
    }, []),
  );

  // Topics Gemini extracted from the selected sources, offered as one-tap
  // starting points for the guide topic — grouped by OpenAlex subfield the
  // same way the Explore tab is.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      listTopics(folderId).then(({ data }) => {
        if (!cancelled) setTopicGroups(groupTopics(aggregateTopics(data ?? [])));
      });
      return () => {
        cancelled = true;
      };
    }, [folderId]),
  );

  const handleGenerate = async () => {
    setError(null);
    setSubmitting(true);
    const input = { topics, title: title.trim() || undefined, folderId };
    const { data, error: generateError } = isDeck
      ? await generateFlashcards(input)
      : await generateGuide(input);
    setSubmitting(false);
    if (generateError || !data) {
      setError(generateError ?? 'Could not start generation');
      return;
    }
    router.replace(isDeck ? `/deck/${data.id}` : `/guide/${data.id}`);
  };

  const folderName = folderId
    ? (folders.find((f) => f.id === folderId)?.name ?? 'Folder')
    : 'All my materials';

  const renderChip = (name: string, key: string) => {
    const selected = selectedTopics.includes(name);
    return (
      <Pressable
        key={key}
        onPress={() => toggleTopic(name)}
        style={[
          styles.chip,
          {
            backgroundColor: selected ? colors.primarySoft : colors.surface,
            borderColor: selected ? colors.primary : colors.border,
          },
        ]}
      >
        {selected ? <Check size={14} color={colors.primary} /> : null}
        <Text style={{ color: selected ? colors.primary : colors.text, fontSize: 14 }}>
          {name}
        </Text>
      </Pressable>
    );
  };

  return (
    <Screen>
      <ScreenHeader title={isDeck ? 'New flashcard deck' : 'New study guide'} showBack />
      <ScrollView
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.form]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.help, { color: colors.textSecondary }]}>
          {isDeck
            ? 'Tell Grappnel what to cover and which sources to use. Cards are built only from your uploaded materials, with figures from your sources where they help.'
            : 'Tell Grappnel what to cover and which sources to use. The guide is built only from your uploaded materials.'}
        </Text>
        {hasTopicChips ? (
          <>
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Topics found in your materials
            </Text>
            <Text style={[styles.hint, { color: colors.textTertiary }]}>
              Tap to add one or more to your guide.
            </Text>
            {extraTopics.length > 0 ? (
              <View style={styles.chips}>
                {extraTopics.map((name) => renderChip(name, `extra::${name}`))}
              </View>
            ) : null}
            {topicGroups.map((group) => (
              <View key={group.key} style={styles.topicGroup}>
                <View>
                  <Text style={[styles.groupTitle, { color: colors.text }]}>
                    {group.label}
                  </Text>
                  {group.sublabel ? (
                    <Text style={[styles.groupSub, { color: colors.textTertiary }]}>
                      {group.sublabel}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.chips}>
                  {group.topics.map((topic) => renderChip(topic.name, topic.key))}
                </View>
              </View>
            ))}
          </>
        ) : null}
        <TextField
          label={hasTopicChips ? 'Add another topic (optional)' : 'Topic'}
          value={customTopic}
          onChangeText={setCustomTopic}
          placeholder="e.g. Photosynthesis light reactions, Chapters 4-6, Midterm 2 review"
          multiline
          numberOfLines={3}
          style={styles.topicInput}
        />
        <TextField
          label="Guide title (optional)"
          value={title}
          onChangeText={setTitle}
          placeholder="Defaults to the topics"
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
          title={isDeck ? 'Generate flashcards' : 'Generate study guide'}
          onPress={handleGenerate}
          loading={submitting}
          disabled={topics.length === 0}
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
  hint: {
    fontSize: 13,
    marginTop: -Spacing.two,
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
  topicGroup: {
    gap: Spacing.two,
  },
  groupTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  groupSub: {
    fontSize: 12,
    marginTop: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
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
