import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Compass } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import {
  aggregateTopics,
  AggregatedTopic,
  groupTopics,
  listTopics,
} from '@/lib/services/topics';

type TopicRowItem = AggregatedTopic & { rowKey: string };

export default function TopicsScreen() {
  const colors = useThemeColors();
  const router = useRouter();

  const [topics, setTopics] = useState<AggregatedTopic[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await listTopics();
    setTopics(aggregateTopics(data ?? []));
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Row keys are scoped by group to stay unique across the whole SectionList.
  const sections = useMemo(
    () =>
      groupTopics(topics).map((group) => ({
        title: group.label,
        sublabel: group.sublabel,
        data: group.topics.map<TopicRowItem>((topic) => ({
          ...topic,
          rowKey: `${group.key}::${topic.key}`,
        })),
      })),
    [topics],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen>
      <ScreenHeader title="Explore topics" />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.rowKey}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {section.title}
            </Text>
            {section.sublabel ? (
              <Text style={[styles.sectionSub, { color: colors.textTertiary }]}>
                {section.sublabel}
              </Text>
            ) : null}
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/topic/[id]', params: { id: item.key } })
            }
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={styles.rowBody}>
              <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={[styles.rowMeta, { color: colors.textTertiary }]}>
                {item.materialCount} {item.materialCount === 1 ? 'source' : 'sources'}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.textTertiary} />
          </Pressable>
        )}
        ListEmptyComponent={
          loaded ? (
            <EmptyState
              icon={Compass}
              title="No topics yet"
              message="Grappnel extracts the main topics from each source after it finishes indexing. Add materials in your Library and they'll show up here."
            />
          ) : null
        }
        SectionSeparatorComponent={() => <View style={styles.gap} />}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.listContent]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  sectionSub: {
    fontSize: 12,
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowMeta: {
    fontSize: 12,
  },
  gap: {
    height: Spacing.two,
  },
  listContent: {
    paddingBottom: Spacing.six,
  },
});
