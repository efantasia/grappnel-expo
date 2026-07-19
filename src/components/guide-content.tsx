import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';

import { screenScroll } from '@/components/ui/screen';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { extractFigureIds, parseGuide, prepareBody, splitFigures } from '@/lib/guide-markdown';
import { signFigureUrls } from '@/lib/services/figures';

// react-native-markdown-display's default markdown-it renders raw `<br>` as
// literal text. Teach it to emit a `hardbreak` token instead, so `<br>`
// becomes a real line break everywhere — including inside table cells, whose
// source row must remain on a single line (a newline there breaks the table).
const markdownIt = MarkdownIt({ typographer: true });
markdownIt.inline.ruler.before(
  'html_inline',
  'grappnel_br',
  (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c /* '<' */) return false;
    const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) state.push('hardbreak', 'br', 0);
    state.pos += match[0].length;
    return true;
  },
);

interface GuideContentProps {
  content: string;
  meta?: string;
}

// Renders a generated study guide: the Markdown body (with math resolved and
// citations shown as tappable superscript footnote references) followed by a
// linked "Sources" footnote list. Owns its ScrollView so a superscript tap can
// scroll to the matching footnote.
export function GuideContent({ content, meta }: GuideContentProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const sourcesTop = useRef(0);
  const footnoteOffsets = useRef<Record<number, number>>({});

  const [figureUrls, setFigureUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ url: string; caption: string } | null>(null);

  const { body, footnotes } = useMemo(() => {
    const parsed = parseGuide(content);
    return { body: prepareBody(parsed.body), footnotes: parsed.footnotes };
  }, [content]);

  // Sign the ids of any figures the guide embeds so they can be displayed
  // (the GCS bucket is private).
  const figureIds = useMemo(() => extractFigureIds(content), [content]);
  useEffect(() => {
    if (figureIds.length === 0) return;
    let cancelled = false;
    signFigureUrls(figureIds).then(({ data }) => {
      if (!cancelled && data) setFigureUrls(data);
    });
    return () => {
      cancelled = true;
    };
  }, [figureIds]);

  // Split the body into markdown runs and figure blocks so each figure renders
  // as its own block (a View) — inline image rendering nests the caption in a
  // paragraph's Text wrapper, where it can't wrap to the content width.
  const segments = useMemo(() => splitFigures(body), [body]);

  // Footnote references are rewritten to `#fn-<n>` links; intercept those to
  // scroll instead of opening a URL, and let real (e.g. video) links open.
  const handleLink = (url: string): boolean => {
    if (url.startsWith('#fn-')) {
      const n = Number(url.slice(4));
      const y = footnoteOffsets.current[n];
      if (Number.isFinite(y)) {
        scrollRef.current?.scrollTo({ y: Math.max(0, sourcesTop.current + y - Spacing.four), animated: true });
      }
      return false;
    }
    return true;
  };

  const markdownStyles = useMemo(
    () => ({
      body: { color: colors.text, fontSize: 15, lineHeight: 23 },
      heading1: { color: colors.text, fontWeight: '700' as const, fontSize: 24, marginTop: Spacing.four, marginBottom: Spacing.two },
      heading2: { color: colors.text, fontWeight: '700' as const, fontSize: 20, marginTop: Spacing.four, marginBottom: Spacing.two },
      heading3: { color: colors.text, fontWeight: '600' as const, fontSize: 17, marginTop: Spacing.three, marginBottom: Spacing.one },
      strong: { color: colors.text, fontWeight: '700' as const },
      link: { color: colors.primary, textDecorationLine: 'none' as const },
      bullet_list: { marginVertical: Spacing.two },
      ordered_list: { marginVertical: Spacing.two },
      blockquote: {
        backgroundColor: colors.surfaceAlt,
        borderLeftColor: colors.primary,
        borderLeftWidth: 3,
        paddingHorizontal: Spacing.three,
      },
      code_inline: {
        backgroundColor: colors.surfaceAlt,
        color: colors.text,
        fontFamily: Fonts?.mono,
      },
      fence: {
        backgroundColor: colors.surfaceAlt,
        borderColor: colors.border,
        color: colors.text,
        fontFamily: Fonts?.mono,
      },
      table: { borderColor: colors.border },
      th: { color: colors.text },
      tr: { borderColor: colors.border },
      hr: { backgroundColor: colors.border },
    }),
    [colors],
  );

  return (
    <>
    <ScrollView
      ref={scrollRef}
      style={screenScroll.scroll}
      contentContainerStyle={[screenScroll.content, styles.content]}
    >
      {meta ? (
        <Text style={[styles.meta, { color: colors.textTertiary }]}>{meta}</Text>
      ) : null}

      {segments.map((seg, i) => {
        if (seg.type === 'figure') {
          const url = figureUrls[seg.id];
          if (!url) return null; // not signed yet
          return (
            <Pressable
              key={`fig-${i}`}
              onPress={() => setLightbox({ url, caption: seg.caption })}
              style={styles.figureWrap}
              accessibilityLabel="View figure full size"
            >
              <Image
                source={{ uri: url }}
                style={[styles.figure, { backgroundColor: colors.surfaceAlt }]}
                contentFit="contain"
                transition={150}
                accessibilityLabel={seg.caption || undefined}
              />
              {seg.caption ? (
                <Text style={[styles.caption, { color: colors.textTertiary }]}>
                  {seg.caption}
                </Text>
              ) : null}
            </Pressable>
          );
        }
        return (
          <Markdown
            key={`md-${i}`}
            style={markdownStyles}
            markdownit={markdownIt}
            onLinkPress={handleLink}
          >
            {seg.text}
          </Markdown>
        );
      })}

      {footnotes.length > 0 ? (
        <View
          style={[styles.sources, { borderTopColor: colors.border }]}
          onLayout={(e: LayoutChangeEvent) => {
            sourcesTop.current = e.nativeEvent.layout.y;
          }}
        >
          <Text style={[styles.sourcesTitle, { color: colors.text }]}>Sources</Text>
          {footnotes.map((fn) => (
            <View
              key={fn.n}
              style={styles.footnote}
              onLayout={(e: LayoutChangeEvent) => {
                footnoteOffsets.current[fn.n] = e.nativeEvent.layout.y;
              }}
            >
              <Text style={[styles.footnoteNum, { color: colors.textTertiary }]}>
                {fn.n}.
              </Text>
              {fn.url ? (
                <Text
                  style={[styles.footnoteText, { color: colors.primary }]}
                  onPress={() => Linking.openURL(fn.url!)}
                >
                  {fn.label}
                </Text>
              ) : (
                <Text style={[styles.footnoteText, { color: colors.textSecondary }]}>
                  {fn.label}
                </Text>
              )}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>

    <Modal
      visible={!!lightbox}
      transparent
      animationType="fade"
      onRequestClose={() => setLightbox(null)}
    >
      <Pressable style={styles.lightboxBackdrop} onPress={() => setLightbox(null)}>
        {lightbox ? (
          <Image
            source={{ uri: lightbox.url }}
            style={styles.lightboxImage}
            contentFit="contain"
            accessibilityLabel={lightbox.caption || undefined}
          />
        ) : null}
        <Pressable
          style={[styles.lightboxClose, { top: insets.top + Spacing.two }]}
          onPress={() => setLightbox(null)}
          hitSlop={12}
          accessibilityLabel="Close"
        >
          <X size={28} color="#fff" />
        </Pressable>
      </Pressable>
    </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: Spacing.six,
  },
  meta: {
    fontSize: 13,
    marginBottom: Spacing.two,
  },
  figureWrap: {
    marginVertical: Spacing.three,
    gap: Spacing.one,
  },
  figure: {
    width: '100%',
    height: 240,
    borderRadius: Radius.sm,
  },
  caption: {
    fontSize: 13,
    fontStyle: 'italic',
    textAlign: 'center',
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
  sources: {
    marginTop: Spacing.five,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  sourcesTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: Spacing.one,
  },
  footnote: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  footnoteNum: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    minWidth: 22,
  },
  footnoteText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});
