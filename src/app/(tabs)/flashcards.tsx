import { useFocusEffect, useRouter } from 'expo-router';
import { Layers, Plus } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';

import { FlashcardDeckRow } from '@/components/flashcard-deck-row';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { Spacing } from '@/constants/theme';
import { useInterval } from '@/hooks/use-interval';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { deleteDeck, listDecks } from '@/lib/services/flashcards';
import { FlashcardDeck } from '@/lib/types';

export default function FlashcardsScreen() {
  const colors = useThemeColors();
  const router = useRouter();

  const [decks, setDecks] = useState<FlashcardDeck[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FlashcardDeck | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await listDecks();
    if (data) setDecks(data);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Refresh while any deck is still generating so statuses settle live.
  const generating = decks.some((d) => d.status === 'generating');
  useInterval(load, generating ? 5000 : null);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    await deleteDeck(pendingDelete.id);
    setDeleting(false);
    setPendingDelete(null);
    await load();
  };

  return (
    <Screen>
      <ScreenHeader
        title="Flashcards"
        right={
          <Pressable
            onPress={() =>
              router.push({ pathname: '/generate', params: { mode: 'flashcards' } })
            }
            hitSlop={8}
          >
            <Plus size={26} color={colors.primary} />
          </Pressable>
        }
      />
      <FlatList
        data={decks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <FlashcardDeckRow
            deck={item}
            onPress={(deck) => router.push(`/deck/${deck.id}`)}
            onMenu={setPendingDelete}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <EmptyState
            icon={Layers}
            title="No flashcard decks yet"
            message="Pick a topic and Grappnel will build a deck from your uploaded materials — with figures from your sources on the cards where they help."
          />
        }
        style={screenScroll.scroll}
        contentContainerStyle={[screenScroll.content, styles.listContent]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />

      <ConfirmModal
        visible={pendingDelete !== null}
        title="Delete deck?"
        message={`"${pendingDelete?.title}" will be permanently deleted.`}
        confirmTitle="Delete"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  separator: {
    height: Spacing.two,
  },
  listContent: {
    paddingBottom: Spacing.six,
  },
});
