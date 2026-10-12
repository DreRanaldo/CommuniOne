import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Alert, type AlertPatch } from '@communione/services';
import { useCallback, useLayoutEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles, useTheme } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import {
  alertError,
  canChangeSeverity,
  formatAlertEnd,
  parseAlertEnd,
  SEVERITY_INFO,
  severityChoices,
  severityOf,
  type Severity,
} from './alertRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AlertEditor'>;

export const TITLE_MAX = 160;
export const BODY_MAX = 5_000;

/** Write a new alert (draft or issued at once), or edit one (loaded from the server). */
export function AlertEditorScreen(props: Props) {
  const alertId = props.route.params?.alertId;
  const { alerts } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<Alert | null> => {
    if (!alertId) return null;
    const found = await alerts.get(alertId);
    if (found.community_id !== community.community_id) throw new Error('not in this community');
    return found;
  }, [alerts, alertId, community.community_id]);
  const existing = useAsync(load);

  if (existing.status === 'loading') return <LoadingState label="Loading the alert…" />;
  if (existing.status === 'error') {
    const gone = !isServiceError(existing.error) || existing.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This alert is not available' : 'The alert could not be loaded'}
        message={gone ? 'It may have been withdrawn.' : errorMessage(existing.error)}
        onRetry={gone ? undefined : existing.reload}
      />
    );
  }
  return <Editor {...props} existing={existing.data} />;
}

type Field = 'title' | 'body' | 'date' | 'time';

function Editor({ navigation, existing }: Props & { existing: Alert | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { alerts } = useServices();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const initialEnd = formatAlertEnd(existing?.expires_at ?? null);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [severity, setSeverity] = useState<Severity>(existing ? severityOf(existing.severity) : 'info');
  const [endDate, setEndDate] = useState(initialEnd.date);
  const [endTime, setEndTime] = useState(initialEnd.time);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'publish' | 'save' | null>(null);

  const choices = severityChoices(permissions.can, existing?.severity);
  const severityLocked = !canChangeSeverity(existing, permissions.can);

  useLayoutEffect(() => {
    navigation.setOptions({ title: existing ? 'Edit alert' : 'New alert' });
  }, [navigation, existing]);

  const save = async (mode: 'draft' | 'publish' | 'save') => {
    const found: Partial<Record<Field, string>> = {};
    if (!title.trim()) found.title = 'Enter a title.';
    else if ([...title.trim()].length > TITLE_MAX) found.title = `Use at most ${TITLE_MAX} characters.`;
    if (!body.trim()) found.body = 'Say what is happening and what to do.';
    else if ([...body].length > BODY_MAX) found.body = `Use at most ${BODY_MAX.toLocaleString()} characters.`;
    const endChanged = endDate !== initialEnd.date || endTime !== initialEnd.time;
    const end = parseAlertEnd(endDate, endTime);
    if ('error' in end && (endChanged || !existing)) found[end.field] = end.error;
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setSaving(mode);
    try {
      // The community comes from the current community; creator, status dates and
      // severity rules are enforced by the database.
      if (existing) {
        const patch: AlertPatch = { title, body };
        if (severity !== existing.severity) patch.severity = severity;
        if (endChanged && 'value' in end) patch.expiresAt = end.value;
        await alerts.edit(existing.id, patch);
      } else {
        await alerts.create({
          communityId: community.community_id,
          title,
          body,
          severity,
          expiresAt: 'value' in end ? end.value : null,
          publish: mode === 'publish',
        });
      }
      navigation.goBack();
    } catch (error) {
      const field = errorField(error);
      if (field === 'title' || field === 'body') setErrors({ [field]: errorMessage(error) });
      else if (field === 'expiresAt') setErrors({ date: errorMessage(error) });
      else setFormError(alertError(error));
      setSaving(null);
    }
  };

  const issueTitle = severity === 'emergency' ? 'Issue emergency alert' : 'Issue now';
  return (
    <Screen testID="alert-editor-screen">
      <Text tone="muted">
        {existing
          ? existing.status === 'published'
            ? 'Changes to an issued alert are shown at once and marked as updated.'
            : 'Editing a draft.'
          : `For everyone in ${community.name}. Push notifications are not sent yet; members see alerts in the app.`}
      </Text>
      {formError ? <Banner tone="danger" message={formError} testID="alert-editor-error" /> : null}
      <View style={styles.group}>
        <Text variant="label">Severity</Text>
        <View style={styles.choices} accessibilityRole="radiogroup">
          {choices.map((level) => {
            const info = SEVERITY_INFO[level];
            const selected = severity === level;
            return (
              <Pressable
                key={level}
                accessibilityRole="radio"
                accessibilityLabel={`${info.label}. ${info.description}`}
                accessibilityState={{ checked: selected, disabled: severityLocked }}
                disabled={severityLocked}
                onPress={() => setSeverity(level)}
                style={[
                  styles.choice,
                  { borderLeftColor: colors.severity[level] },
                  selected && styles.choiceSelected,
                ]}
                testID={`severity-choice-${level}`}
              >
                <Icon name={info.icon} size={20} color={colors.severity[level]} />
                <View style={styles.choiceText}>
                  <Text variant="label" style={styles.choiceLabel}>
                    {info.label.toUpperCase()}
                    {selected ? '  ✓' : ''}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {info.description}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {severityLocked ? (
          <Text variant="caption" tone="muted" testID="severity-locked">
            Only people who manage alerts can change the severity now.
          </Text>
        ) : !choices.includes('emergency') ? (
          <Text variant="caption" tone="muted">
            Emergency alerts can be issued only by people who manage alerts.
          </Text>
        ) : null}
      </View>
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={errors.title}
        maxLength={TITLE_MAX + 40}
      />
      <TextField
        label="What is happening and what to do"
        value={body}
        onChangeText={setBody}
        multiline
        error={errors.body}
      />
      <View style={styles.row}>
        <View style={styles.flex}>
          <TextField
            label="Ends on (optional)"
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            error={errors.date}
          />
        </View>
        <View style={styles.flex}>
          <TextField
            label="At (optional)"
            value={endTime}
            onChangeText={setEndTime}
            placeholder="HH:MM"
            keyboardType="numbers-and-punctuation"
            error={errors.time}
          />
        </View>
      </View>
      <Text variant="caption" tone="muted">
        After this time the alert stops being active and stays in History. Without a time: the end of that
        day.
      </Text>
      {existing ? (
        <Button title="Save changes" loading={saving === 'save'} onPress={() => void save('save')} />
      ) : (
        <>
          <Button
            title={issueTitle}
            variant={severity === 'emergency' ? 'danger' : 'primary'}
            loading={saving === 'publish'}
            disabled={saving !== null}
            onPress={() => void save('publish')}
          />
          <Button
            title="Save as draft"
            variant="secondary"
            loading={saving === 'draft'}
            disabled={saving !== null}
            onPress={() => void save('draft')}
          />
        </>
      )}
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={saving !== null} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  group: { gap: t.spacing.xs },
  choices: { gap: t.spacing.xs },
  choice: {
    minHeight: t.touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    padding: t.spacing.sm,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderLeftWidth: 6,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  choiceSelected: { borderColor: t.colors.primary, borderWidth: 2, backgroundColor: t.colors.surfaceMuted },
  choiceText: { flex: 1 },
  choiceLabel: { fontWeight: '700', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: t.spacing.sm },
  flex: { flex: 1 },
}));
