import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { Button } from '@/components/ui/button';
import { Spacing } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme-colors';

interface ConfirmModalProps {
  visible: boolean;
  title: string;
  message: string;
  confirmTitle?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmTitle = 'Confirm',
  destructive = false,
  loading = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const colors = useThemeColors();
  return (
    <AppModal visible={visible} title={title} onClose={onClose}>
      <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
      <View style={styles.actions}>
        <Button title="Cancel" variant="secondary" onPress={onClose} style={styles.action} />
        <Button
          title={confirmTitle}
          variant={destructive ? 'danger' : 'primary'}
          onPress={onConfirm}
          loading={loading}
          style={styles.action}
        />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  message: {
    fontSize: 15,
    lineHeight: 21,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  action: {
    flex: 1,
  },
});
