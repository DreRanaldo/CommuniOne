import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, TextField } from '@/components';
import { makeStyles } from '@/theme';
import { errorMessage } from '@/utils/errors';

export const COMMENT_MAX_LENGTH = 5_000;

/**
 * Writes a comment or reply. Not optimistic: the comment appears once the
 * server has accepted it. While a request runs, sending is disabled, so a
 * double tap cannot post twice.
 */
export function CommentComposer({
  label,
  submitTitle = 'Send',
  initial = '',
  onSubmit,
  onCancel,
  testID,
}: {
  label: string;
  submitTitle?: string;
  initial?: string;
  /** Resolves when the server accepted the text; rejects with the server's error. */
  onSubmit(body: string): Promise<void>;
  onCancel?: () => void;
  testID?: string;
}) {
  const styles = useStyles();
  const [body, setBody] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A ref, not state: two taps in the same frame must not both get through.
  const inFlight = useRef(false);

  const submit = async () => {
    if (inFlight.current) return;
    if (!body.trim()) {
      setError('Write something first.');
      return;
    }
    if ([...body].length > COMMENT_MAX_LENGTH) {
      setError(`Use at most ${COMMENT_MAX_LENGTH.toLocaleString()} characters.`);
      return;
    }
    setError(null);
    inFlight.current = true;
    setSending(true);
    try {
      await onSubmit(body);
      setBody('');
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <View style={styles.container} testID={testID}>
      <TextField
        label={label}
        value={body}
        onChangeText={setBody}
        multiline
        error={error}
        editable={!sending}
      />
      <View style={styles.row}>
        <Button title={submitTitle} fullWidth={false} loading={sending} onPress={() => void submit()} />
        {onCancel ? (
          <Button title="Cancel" variant="ghost" fullWidth={false} onPress={onCancel} disabled={sending} />
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.sm, alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: t.spacing.sm },
}));
