import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { ChevronLeft, ChevronRight, Lightbulb, Maximize2, X } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OccludedImage } from '@/components/occluded-image';
import { Button } from '@/components/ui/button';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Screen, screenScroll } from '@/components/ui/screen';
import { StatusBadge } from '@/components/ui/status-badge';
import { Radius, Spacing } from '@/constants/theme';
import { useInterval } from '@/hooks/use-interval';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { getDeck, listCards, signFigureUrls } from '@/lib/services/flashcards';
import { Flashcard, FlashcardDeck } from '@/lib/types';

export default function DeckScreen() {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [deck, setDeck] = useState<FlashcardDeck | null>(null);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [figureUrls, setFigureUrls] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const { data: deckData } = await getDeck(id);
    if (deckData) setDeck(deckData);
    if (deckData?.status === 'complete') {
      const { data: cardData } = await listCards(id);
      if (cardData) {
        setCards(cardData);
        const figureIds = [
          ...new Set(cardData.map((c) => c.figure_id).filter((f): f is string => !!f)),
        ];
        if (figureIds.length > 0) {
          const { data: urls } = await signFigureUrls(figureIds);
          if (urls) setFigureUrls(urls);
        }
      }
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Poll while the deck is still generating in the background.
  useInterval(load, deck?.status === 'generating' ? 4000 : null);

  const goTo = (next: number) => {
    setIndex(next);
    setRevealed(false);
  };

  const card = cards[index];
  const figureUri = card?.figure_id ? figureUrls[card.figure_id] : undefined;
  const hasHints = cards.some((c) => !!c.hint);

  const cardFigure = card?.material_figures ?? null;
  const occlusionBoxes = card?.occlusion ?? null;
  const occlusionContext = card?.occlusion_context ?? null;
  const isOcclusion =
    card?.type === 'image_occlusion' &&
    !!occlusionBoxes?.length &&
    !!cardFigure?.width &&
    !!cardFigure?.height;
  // Never show the raw image of an occlusion card if we can't mask it — that
  // would expose the answer. Non-occlusion figure cards always show.
  const showFigure = !!figureUri && (card?.type !== 'image_occlusion' || isOcclusion);

  return (
    <Screen>
      <ScreenHeader
        title={deck?.title ?? 'Deck'}
        showBack
        right={
          deck && hasHints ? (
            <Pressable
              onPress={() => setShowHints((s) => !s)}
              hitSlop={8}
              accessibilityLabel={showHints ? 'Hide hints' : 'Show hints'}
            >
              <Lightbulb
                size={22}
                color={showHints ? colors.primary : colors.textTertiary}
              />
            </Pressable>
          ) : null
        }
      />

      {!deck ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : deck.status === 'generating' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            Building your flashcards from your sources… this usually takes
            a minute or two.
          </Text>
        </View>
      ) : deck.status === 'error' ? (
        <View style={styles.center}>
          {/* Wrap so the badge's own alignSelf:'flex-start' doesn't pin it left
              of the centered message. */}
          <View>
            <StatusBadge status="error" />
          </View>
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            {deck.error_message ?? 'Something went wrong generating this deck.'}
          </Text>
        </View>
      ) : cards.length === 0 || !card ? (
        <View style={styles.center}>
          <Text style={[styles.centerText, { color: colors.textSecondary }]}>
            This deck has no cards.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={screenScroll.scroll}
          contentContainerStyle={[screenScroll.content, styles.content]}
        >
          <Text style={[styles.progress, { color: colors.textTertiary }]}>
            {index + 1} / {cards.length}
          </Text>

          <Pressable
            onPress={() => setRevealed((r) => !r)}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            {showFigure && figureUri ? (
              <Pressable
                style={styles.figureWrap}
                // Don't let tapping the image flip the card — open it full-size.
                onPress={(e) => {
                  e.stopPropagation?.();
                  setLightboxOpen(true);
                }}
                accessibilityLabel="View figure full size"
              >
                {isOcclusion ? (
                  <OccludedImage
                    uri={figureUri}
                    width={cardFigure?.width ?? null}
                    height={cardFigure?.height ?? null}
                    boxes={occlusionBoxes ?? []}
                    contextBoxes={occlusionContext ?? []}
                    revealed={revealed}
                    style={[styles.figure, { backgroundColor: colors.surfaceAlt }]}
                    maskColor={colors.primary}
                    questionColor={colors.onPrimary}
                    contextColor={colors.textTertiary}
                  />
                ) : (
                  <Image
                    source={{ uri: figureUri }}
                    style={[styles.figure, { backgroundColor: colors.surfaceAlt }]}
                    contentFit="contain"
                    transition={150}
                    accessibilityLabel={card.material_figures?.alt_text ?? undefined}
                  />
                )}
                <View style={styles.expandBadge}>
                  <Maximize2 size={15} color="#fff" />
                </View>
              </Pressable>
            ) : null}

            <Text style={[styles.side, { color: colors.textTertiary }]}>
              {card.type === 'basic' ? 'Question' : 'Fill in the blank'}
            </Text>
            <Text style={[styles.front, { color: colors.text }]}>{card.front}</Text>

            {card.hint && !revealed && showHints ? (
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                Hint: {card.hint}
              </Text>
            ) : null}

            {revealed ? (
              <View style={[styles.answerBlock, { borderTopColor: colors.border }]}>
                <Text style={[styles.side, { color: colors.textTertiary }]}>Answer</Text>
                {card.type === 'cloze' && card.front.includes('_____') ? (
                  // Show the completed statement with the filled term highlighted.
                  <Text style={[styles.back, { color: colors.text }]}>
                    {card.front.split('_____')[0]}
                    <Text style={{ color: colors.primary, fontWeight: '700' }}>
                      {card.back}
                    </Text>
                    {card.front.split('_____').slice(1).join('_____')}
                  </Text>
                ) : (
                  <Text style={[styles.back, { color: colors.text }]}>{card.back}</Text>
                )}
              </View>
            ) : null}

            {card.citation && revealed ? (
              <Text style={[styles.citation, { color: colors.textTertiary }]}>
                Source: {card.citation}
              </Text>
            ) : null}
          </Pressable>

          <Button
            title={revealed ? 'Hide answer' : 'Show answer'}
            variant="secondary"
            onPress={() => setRevealed((r) => !r)}
          />

          <View style={styles.nav}>
            <Pressable
              onPress={() => goTo(index - 1)}
              disabled={index === 0}
              style={[
                styles.navButton,
                { borderColor: colors.border, opacity: index === 0 ? 0.4 : 1 },
              ]}
            >
              <ChevronLeft size={20} color={colors.text} />
              <Text style={{ color: colors.text, fontSize: 15 }}>Previous</Text>
            </Pressable>
            <Pressable
              onPress={() => goTo(index + 1)}
              disabled={index === cards.length - 1}
              style={[
                styles.navButton,
                {
                  borderColor: colors.border,
                  opacity: index === cards.length - 1 ? 0.4 : 1,
                },
              ]}
            >
              <Text style={{ color: colors.text, fontSize: 15 }}>Next</Text>
              <ChevronRight size={20} color={colors.text} />
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/* Full-size figure viewer: tap anywhere (or the ✕) to dismiss. */}
      <Modal
        visible={lightboxOpen && showFigure}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxOpen(false)}
      >
        <Pressable style={styles.lightboxBackdrop} onPress={() => setLightboxOpen(false)}>
          {figureUri && isOcclusion ? (
            <OccludedImage
              uri={figureUri}
              width={cardFigure?.width ?? null}
              height={cardFigure?.height ?? null}
              boxes={occlusionBoxes ?? []}
              contextBoxes={occlusionContext ?? []}
              revealed={revealed}
              style={styles.lightboxImage}
              maskColor={colors.primary}
              questionColor={colors.onPrimary}
              contextColor={colors.textTertiary}
            />
          ) : figureUri ? (
            <Image
              source={{ uri: figureUri }}
              style={styles.lightboxImage}
              contentFit="contain"
              accessibilityLabel={card?.material_figures?.alt_text ?? undefined}
            />
          ) : null}
          <Pressable
            style={[styles.lightboxClose, { top: insets.top + Spacing.two }]}
            onPress={() => setLightboxOpen(false)}
            hitSlop={12}
            accessibilityLabel="Close"
          >
            <X size={28} color="#fff" />
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  centerText: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 340,
  },
  content: {
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingBottom: Spacing.six,
  },
  progress: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.four,
    gap: Spacing.two,
    minHeight: 220,
  },
  figureWrap: {
    position: 'relative',
    marginBottom: Spacing.two,
  },
  figure: {
    width: '100%',
    height: 240,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  expandBadge: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: Radius.pill,
    padding: 6,
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
  },
  lightboxImage: {
    width: '100%',
    height: '100%',
  },
  lightboxClose: {
    position: 'absolute',
    right: Spacing.three,
    padding: Spacing.two,
  },
  side: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  front: {
    fontSize: 19,
    lineHeight: 27,
    fontWeight: '600',
  },
  hint: {
    fontSize: 14,
    fontStyle: 'italic',
    marginTop: Spacing.one,
  },
  answerBlock: {
    borderTopWidth: 1,
    marginTop: Spacing.three,
    paddingTop: Spacing.three,
    gap: Spacing.two,
  },
  back: {
    fontSize: 16,
    lineHeight: 24,
  },
  citation: {
    fontSize: 12,
    marginTop: Spacing.two,
  },
  nav: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  navButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: 12,
  },
});
