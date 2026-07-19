import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { CirclePlay, ExternalLink, FileText, Layers, MoreVertical } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MaterialActions } from '@/components/material-actions';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { listFolders } from '@/lib/services/folders';
import {
  aggregateTopics,
  AggregatedTopic,
  formatTopicDescription,
  listTopics,
  openAlexPath,
} from '@/lib/services/topics';
import { Folder, Material } from '@/lib/types';

export default function TopicDetailScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  // Topics are identified by their OpenAlex topic id (e.g. "T10085").
  const { id } = useLocalSearchParams<{ id: string }>();

  const [topic, setTopic] = useState<AggregatedTopic | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [topicResult, folderResult] = await Promise.all([
      listTopics(),
      listFolders(),
    ]);
    setTopic(aggregateTopics(topicResult.data ?? []).find((t) => t.key === id) ?? null);
    if (folderResult.data) setFolders(folderResult.data);
    setLoaded(true);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!topic) {
    return (
      <Screen>
        <ScreenHeader title="Topic" showBack />
        {loaded ? (
          <EmptyState
            icon={Layers}
            title="Topic not found"
            message="This topic is no longer in your materials. It may have been re-classified after a source changed."
          />
        ) : null}
      </Screen>
    );
  }

  const openAlex = openAlexPath(topic);

  return (
    <Screen>
      <ScreenHeader title={topic.name} showBack />
      <ScrollView
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.content]}
      >
        <Button
          title="Build a study guide on this topic"
          onPress={() =>
            router.push({ pathname: '/generate', params: { topic: topic.name } })
          }
        />

        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          Classification
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {openAlex ? (
            <ClassificationRow
              colors={colors}
              label="OpenAlex"
              value={openAlex}
              caption={`Topic ${topic.openalexTopicId}`}
            />
          ) : null}
          {topic.openalexDescription ? (
            <View style={styles.classRow}>
              <Text style={[styles.classLabel, { color: colors.textTertiary }]}>
                OpenAlex description
              </Text>
              <Text style={[styles.classValue, { color: colors.text }]}>
                {formatTopicDescription(topic.openalexDescription)}
              </Text>
            </View>
          ) : null}
          {topic.openalexKeywords.length > 0 ? (
            <View style={styles.classRow}>
              <Text style={[styles.classLabel, { color: colors.textTertiary }]}>
                Keywords
              </Text>
              <View style={styles.chips}>
                {topic.openalexKeywords.map((keyword) => (
                  <View
                    key={keyword}
                    style={[styles.chip, { backgroundColor: colors.surfaceAlt }]}
                  >
                    <Text style={{ color: colors.text, fontSize: 13 }}>{keyword}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
          {topic.wikipediaUrl ? (
            <View style={styles.classRow}>
              <Text style={[styles.classLabel, { color: colors.textTertiary }]}>
                Wikipedia
              </Text>
              <Pressable
                onPress={() => Linking.openURL(topic.wikipediaUrl!)}
                style={styles.wikiLink}
              >
                <ExternalLink size={15} color={colors.primary} />
                <Text style={[styles.wikiText, { color: colors.primary }]}>
                  {topic.wikipediaTitle ?? 'View on Wikipedia'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          {topic.materialCount} {topic.materialCount === 1 ? 'source covers' : 'sources cover'} this
        </Text>
        <View style={styles.sourceList}>
          {topic.materials.map((material) => {
            const Icon = material.source_type === 'youtube' ? CirclePlay : FileText;
            return (
              <View
                key={material.id}
                style={[styles.source, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <Pressable
                  style={styles.sourceBody}
                  disabled={!material.folder_id}
                  onPress={() => router.push(`/folder/${material.folder_id}`)}
                >
                  <View style={[styles.sourceIcon, { backgroundColor: colors.primarySoft }]}>
                    <Icon size={18} color={colors.primary} />
                  </View>
                  <Text style={[styles.sourceTitle, { color: colors.text }]} numberOfLines={2}>
                    {material.title}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setSelectedMaterial(material)}
                  hitSlop={8}
                  style={styles.sourceMenu}
                >
                  <MoreVertical size={20} color={colors.textSecondary} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </ScrollView>

      <MaterialActions
        material={selectedMaterial}
        folders={folders}
        onDismiss={() => setSelectedMaterial(null)}
        onChanged={load}
      />
    </Screen>
  );
}

function ClassificationRow({
  colors,
  label,
  value,
  caption = null,
}: {
  colors: ReturnType<typeof useThemeColors>;
  label: string;
  value: string;
  caption?: string | null;
}) {
  return (
    <View style={styles.classRow}>
      <Text style={[styles.classLabel, { color: colors.textTertiary }]}>{label}</Text>
      <Text style={[styles.classValue, { color: colors.text }]}>{value}</Text>
      {caption ? (
        <Text style={[styles.classCaption, { color: colors.textTertiary }]}>{caption}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.three,
    paddingBottom: Spacing.six,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  classRow: {
    gap: Spacing.one,
  },
  classLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  classValue: {
    fontSize: 15,
    lineHeight: 21,
  },
  classCaption: {
    fontSize: 12,
    marginTop: 2,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  wikiLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  wikiText: {
    fontSize: 15,
    fontWeight: '600',
  },
  sourceList: {
    gap: Spacing.two,
  },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  sourceBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  sourceMenu: {
    padding: 2,
  },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
});
