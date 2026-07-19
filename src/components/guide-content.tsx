import React, { useMemo, useRef } from 'react';
import {
  LayoutChangeEvent,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';

import { Fonts, Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { parseGuide, prepareBody } from '@/lib/guide-markdown';

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
  const scrollRef = useRef<ScrollView>(null);
  const sourcesTop = useRef(0);
  const footnoteOffsets = useRef<Record<number, number>>({});

  const { body, footnotes } = useMemo(() => {
    const parsed = parseGuide(content);
    return { body: prepareBody(parsed.body), footnotes: parsed.footnotes };
  }, [content]);

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
    <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
      {meta ? (
        <Text style={[styles.meta, { color: colors.textTertiary }]}>{meta}</Text>
      ) : null}

      <Markdown style={markdownStyles} markdownit={markdownIt} onLinkPress={handleLink}>
        {body}
      </Markdown>

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
