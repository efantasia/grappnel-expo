import React, { useState } from 'react';
import { StyleSheet, TextInputProps, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';

interface PromptModalProps {
  visible: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmTitle?: string;
  loading?: boolean;
  error?: string | null;
  // Extra TextInput props, e.g. keyboardType="url" for link entry.
  inputProps?: TextInputProps;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptModal({
  visible,
  title,
  placeholder,
  initialValue = '',
  confirmTitle = 'Save',
  loading = false,
  error,
  inputProps,
  onConfirm,
  onClose,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);

  // Reset the draft each time the modal opens ("adjust state during render"
  // pattern — avoids an extra effect-driven render).
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setValue(initialValue);
  }

  return (
    <AppModal visible={visible} title={title} onClose={onClose}>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        autoFocus
        error={error}
        onSubmitEditing={() => onConfirm(value)}
        {...inputProps}
      />
      <View style={styles.actions}>
        <Button title="Cancel" variant="secondary" onPress={onClose} style={styles.action} />
        <Button
          title={confirmTitle}
          onPress={() => onConfirm(value)}
          loading={loading}
          disabled={!value.trim()}
          style={styles.action}
        />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  action: {
    flex: 1,
  },
});
