import { useState } from 'react';
import { View } from 'react-native';
import { Button, Text, TextField } from '@/components';
import { makeStyles } from '@/theme';

export interface ModerationControlsProps {
  kind: 'post' | 'comment';
  status: string;
  /** Present only for holders of posts.moderate / comments.moderate (the server re-checks). */
  onHide?: (reason: string) => Promise<void>;
  onRestore?: () => Promise<void>;
}

/** Moderator actions: hide (with an optional reason shown to the author) or restore. */
export function ModerationControls({ kind, status, onHide, onRestore }: ModerationControlsProps) {
  const styles = useStyles();
  const [hiding, setHiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setHiding(false);
      setReason('');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'hidden' && onRestore) {
    return (
      <Button
        title="Restore"
        variant="ghost"
        fullWidth={false}
        loading={busy}
        onPress={() => void run(onRestore)}
        accessibilityLabel={`Restore ${kind}`}
      />
    );
  }
  if (status !== 'published' || !onHide) return null;
  if (!hiding) {
    return (
      <Button
        title="Hide"
        variant="ghost"
        fullWidth={false}
        onPress={() => setHiding(true)}
        accessibilityLabel={`Hide ${kind}`}
      />
    );
  }
  return (
    <View style={styles.form} testID={`hide-${kind}-form`}>
      <Text>Hide this {kind} from members? Its author will still see it, with your reason.</Text>
      <TextField label="Reason (optional)" value={reason} onChangeText={setReason} maxLength={500} />
      <View style={styles.row}>
        <Button
          title={`Hide ${kind}`}
          variant="danger"
          fullWidth={false}
          loading={busy}
          onPress={() => void run(() => onHide(reason))}
        />
        <Button
          title="Cancel"
          variant="ghost"
          fullWidth={false}
          onPress={() => setHiding(false)}
          disabled={busy}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  form: { gap: t.spacing.sm, alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: t.spacing.sm },
}));
