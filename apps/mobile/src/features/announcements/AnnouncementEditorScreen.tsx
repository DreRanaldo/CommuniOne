import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Announcement } from '@communione/services';
import { useCallback, useLayoutEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import { announcementError, formatExpiryDate, parseExpiryDate } from './announcementRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AnnouncementEditor'>;

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;

/** Write a new announcement (draft or published at once), or edit one (loaded from the server). */
export function AnnouncementEditorScreen(props: Props) {
  const announcementId = props.route.params?.announcementId;
  const { announcements } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<Announcement | null> => {
    if (!announcementId) return null;
    const found = await announcements.get(announcementId);
    if (found.community_id !== community.community_id) throw new Error('not in this community');
    return found;
  }, [announcements, announcementId, community.community_id]);
  const existing = useAsync(load);

  if (existing.status === 'loading') return <LoadingState label="Loading the announcement…" />;
  if (existing.status === 'error') {
    const gone = !isServiceError(existing.error) || existing.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={gone ? 'This announcement is not available' : 'The announcement could not be loaded'}
        message={gone ? 'It may have been withdrawn.' : errorMessage(existing.error)}
        onRetry={gone ? undefined : existing.reload}
      />
    );
  }
  return <Editor {...props} existing={existing.data} />;
}

type Field = 'title' | 'body' | 'expires';

function Editor({ navigation, existing }: Props & { existing: Announcement | null }) {
  const styles = useStyles();
  const { announcements } = useServices();
  const community = useCommunity();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [important, setImportant] = useState(existing?.priority === 'important');
  const [expires, setExpires] = useState(formatExpiryDate(existing?.expires_at ?? null));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'publish' | 'save' | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({ title: existing ? 'Edit announcement' : 'New announcement' });
  }, [navigation, existing]);

  const save = async (mode: 'draft' | 'publish' | 'save') => {
    const found: Partial<Record<Field, string>> = {};
    if (!title.trim()) found.title = 'Enter a title.';
    else if ([...title.trim()].length > TITLE_MAX) found.title = `Use at most ${TITLE_MAX} characters.`;
    if (!body.trim()) found.body = 'Write the announcement.';
    else if ([...body].length > BODY_MAX) found.body = `Use at most ${BODY_MAX.toLocaleString()} characters.`;
    const expiry = parseExpiryDate(expires);
    if ('error' in expiry) found.expires = expiry.error;
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0 || 'error' in expiry) return;
    setSaving(mode);
    try {
      const fields = {
        title,
        body,
        priority: important ? ('important' as const) : ('normal' as const),
        expiresAt: expiry.value,
      };
      // The community comes from the current community; author and dates are set by the database.
      if (existing) await announcements.edit(existing.id, fields);
      else
        await announcements.create({
          communityId: community.community_id,
          ...fields,
          publish: mode === 'publish',
        });
      navigation.goBack();
    } catch (error) {
      const field = errorField(error);
      if (field === 'title' || field === 'body') setErrors({ [field]: errorMessage(error) });
      else if (field === 'expiresAt') setErrors({ expires: errorMessage(error) });
      else setFormError(announcementError(error));
      setSaving(null);
    }
  };

  return (
    <Screen testID="announcement-editor-screen">
      <Text tone="muted">
        {existing
          ? 'Changes to a published announcement are marked as edited.'
          : `For everyone in ${community.name}.`}
      </Text>
      {formError ? <Banner tone="danger" message={formError} testID="announcement-editor-error" /> : null}
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={errors.title}
        maxLength={TITLE_MAX + 50}
      />
      <View style={styles.priority}>
        <Text variant="label">Priority</Text>
        <View style={styles.row} accessibilityRole="radiogroup">
          {[
            { value: false, label: 'Normal' },
            { value: true, label: 'Important' },
          ].map((option) => (
            <Pressable
              key={option.label}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: important === option.value }}
              onPress={() => setImportant(option.value)}
              style={[styles.chip, important === option.value && styles.chipSelected]}
            >
              <Text variant="label" tone={important === option.value ? 'inverse' : 'default'}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextField label="Announcement" value={body} onChangeText={setBody} multiline error={errors.body} />
      <TextField
        label="Expires on (optional)"
        value={expires}
        onChangeText={setExpires}
        placeholder="YYYY-MM-DD"
        hint="After this day it leaves the current announcements and stays under Past."
        keyboardType="numbers-and-punctuation"
        error={errors.expires}
      />
      {existing ? (
        <Button title="Save changes" loading={saving === 'save'} onPress={() => void save('save')} />
      ) : (
        <>
          <Button
            title="Publish now"
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
  priority: { gap: t.spacing.xs },
  row: { flexDirection: 'row', gap: t.spacing.sm },
  chip: {
    minHeight: t.touchTarget,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  chipSelected: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
}));
