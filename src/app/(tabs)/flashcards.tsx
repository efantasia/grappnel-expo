import { useFocusEffect, useRouter } from 'expo-router';
import { Layers, Plus } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FlashcardDeckRow } from '@/components/flashcard-deck-row';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { OptionsModal } from '@/components/ui/options-modal';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useInterval } from '@/hooks/use-interval';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ankiFileName, toAnkiTsv } from '@/lib/anki-export';
import { downloadFileFromUrl, downloadTextFile } from '@/lib/download';
import {
  checkAnkiExport,
  deleteDeck,
  listCards,
  listDecks,
  startAnkiExport,
} from '@/lib/services/flashcards';
import { FlashcardDeck } from '@/lib/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The export job can be slow on a cold start (container spin-up) or for a large
// deck, so poll generously — ~4 minutes, well under the job's own 15-min limit.
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 96;

export default function FlashcardsScreen() {
  const colors = useThemeColors();
  const router = useRouter();

  const [decks, setDecks] = useState<FlashcardDeck[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuDeck, setMenuDeck] = useState<FlashcardDeck | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FlashcardDeck | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Text export builds the file client-side, so it needs the deck's cards.
  const handleExportText = async (deck: FlashcardDeck) => {
    setExportError(null);
    const { data } = await listCards(deck.id);
    if (!data || data.length === 0) {
      setExportError('This deck has no cards to export.');
      return;
    }
    try {
      await downloadTextFile(ankiFileName(deck.title), toAnkiTsv(deck, data));
    } catch {
      // Sharing can be cancelled or unavailable on the device — nothing to do.
    }
  };

  // The .apkg (figures embedded, occlusion baked in) is built server-side;
  // poll the export job until the file is ready, then download it.
  const handleExportApkg = async (deck: FlashcardDeck) => {
    setExportError(null);
    setExporting(true);
    const fileName = ankiFileName(deck.title).replace(/\.txt$/, '.apkg');
    try {
      const { data, error } = await startAnkiExport(deck.id);
      if (error || !data) throw new Error(error ?? 'Could not start the export.');
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        const { data: status } = await checkAnkiExport(data.export_id, fileName);
        if (status?.status === 'ready' && status.url) {
          try {
            await downloadFileFromUrl(fileName, status.url, 'application/octet-stream');
          } catch {
            // Share sheet cancelled/unavailable — the file was still built.
          }
          return;
        }
        if (status?.status === 'error') throw new Error(status.message ?? 'Export failed.');
      }
      throw new Error('The export is taking longer than expected — please try again in a moment.');
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const menuOptions = menuDeck
    ? [
        ...(menuDeck.status === 'complete'
          ? [
              {
                label: 'Export to Anki (.apkg, with images)',
                onPress: () => {
                  const deck = menuDeck;
                  setMenuDeck(null);
                  handleExportApkg(deck);
                },
              },
              {
                label: 'Export as text (.txt)',
                onPress: () => {
                  const deck = menuDeck;
                  setMenuDeck(null);
                  handleExportText(deck);
                },
              },
            ]
          : []),
        {
          label: 'Delete',
          destructive: true,
          onPress: () => {
            const deck = menuDeck;
            setMenuDeck(null);
            setPendingDelete(deck);
          },
        },
      ]
    : [];

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

      {exporting ? (
        <View style={styles.bannerWrap}>
          <View style={[styles.banner, { backgroundColor: colors.primarySoft }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 13, flex: 1 }}>
              Preparing your Anki deck… leave this window open until completed.
            </Text>
          </View>
        </View>
      ) : null}
      {exportError ? (
        <View style={styles.bannerWrap}>
          <Pressable
            onPress={() => setExportError(null)}
            style={[styles.banner, { backgroundColor: colors.dangerSoft }]}
          >
            <Text style={{ color: colors.danger, fontSize: 13, flex: 1 }}>{exportError}</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={decks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <FlashcardDeckRow
            deck={item}
            onPress={(deck) => router.push(`/deck/${deck.id}`)}
            onMenu={setMenuDeck}
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

      <OptionsModal
        visible={menuDeck !== null}
        title={menuDeck?.title}
        onClose={() => setMenuDeck(null)}
        options={menuOptions}
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
  bannerWrap: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    marginTop: Spacing.two,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Radius.md,
    padding: Spacing.three,
  },
});
