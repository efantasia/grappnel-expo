import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { Radius } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

export interface ModalOption {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function OptionsModal({
  visible,
  title,
  options,
  onClose,
}: {
  visible: boolean;
  title?: string;
  options: ModalOption[];
  onClose: () => void;
}) {
  const colors = useThemeColors();
  return (
    <AppModal visible={visible} title={title} onClose={onClose}>
      {options.map((option) => (
        <Pressable
          key={option.label}
          disabled={option.disabled}
          onPress={option.onPress}
          style={({ pressed }) => [
            styles.option,
            {
              backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
              opacity: option.disabled ? 0.4 : 1,
            },
          ]}
        >
          <Text
            style={[
              styles.optionLabel,
              { color: option.destructive ? colors.danger : colors.text },
            ]}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </AppModal>
  );
}

const styles = StyleSheet.create({
  option: {
    borderRadius: Radius.sm,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  optionLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
});
