import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { Radius } from '@/constants/theme';
import { OcclusionBox } from '@/lib/types';

// Detected label boxes can be slightly small or shifted, leaving part of the
// label showing. Pad the mask so it reliably covers the whole label — a mix of
// box-relative and image-relative padding, because the box error is often a
// roughly fixed offset rather than proportional to the (small) label box.
// Over-covering is safe; under-covering exposes the answer.
const PAD_BOX = 0.25; // + this fraction of the box, each side
const PAD_IMG_X = 0.03; // + this fraction of the image width, each side
const PAD_IMG_Y = 0.02; // + this fraction of the image height, each side

// Renders a figure with one or more label regions masked out (image-occlusion
// cloze). Boxes are [x, y, w, h] fractions of the figure; we map them onto the
// on-screen image using its intrinsic width/height and the measured container,
// accounting for `contain` letterboxing. Masks disappear when `revealed`.
//
// The image is withheld until the container has been measured (so a mask is
// never a frame late — which would flash the answer), and when intrinsic
// dimensions are missing the unrevealed image is not shown at all.
export function OccludedImage({
  uri,
  width,
  height,
  boxes,
  revealed,
  style,
  maskColor,
  questionColor,
  contentFit = 'contain',
}: {
  uri: string;
  width: number | null;
  height: number | null;
  boxes: OcclusionBox[];
  revealed: boolean;
  style?: StyleProp<ViewStyle>;
  maskColor: string;
  questionColor: string;
  contentFit?: 'contain' | 'cover';
}) {
  const [layout, setLayout] = useState<{ w: number; h: number } | null>(null);
  const canMask = !!(width && height);

  const rects = useMemo(() => {
    if (!layout || !width || !height) return [];
    const scale =
      contentFit === 'cover'
        ? Math.max(layout.w / width, layout.h / height)
        : Math.min(layout.w / width, layout.h / height);
    const dispW = width * scale;
    const dispH = height * scale;
    const offX = (layout.w - dispW) / 2;
    const offY = (layout.h - dispH) / 2;
    return boxes.map((b) => {
      const padX = b[2] * PAD_BOX + PAD_IMG_X;
      const padY = b[3] * PAD_BOX + PAD_IMG_Y;
      const x = Math.max(0, b[0] - padX);
      const y = Math.max(0, b[1] - padY);
      const w = Math.min(1 - x, b[2] + 2 * padX);
      const h = Math.min(1 - y, b[3] + 2 * padY);
      return {
        left: offX + x * dispW,
        top: offY + y * dispH,
        width: w * dispW,
        height: h * dispH,
      };
    });
  }, [layout, width, height, boxes, contentFit]);

  // When not revealed we only show the image once masks can be placed, so the
  // hidden label is never briefly visible.
  const showImage = revealed || (canMask && !!layout);

  return (
    <View
      style={style}
      onLayout={(e) =>
        setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {showImage ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit={contentFit}
          transition={150}
        />
      ) : null}
      {!revealed && layout
        ? rects.map((r, i) => (
            <View
              key={i}
              pointerEvents="none"
              style={[styles.mask, r, { backgroundColor: maskColor }]}
            >
              <Text style={[styles.q, { color: questionColor }]} numberOfLines={1}>
                ?
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mask: {
    position: 'absolute',
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  q: {
    fontSize: 14,
    fontWeight: '700',
  },
});
