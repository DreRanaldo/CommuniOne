import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CreatedInvitation, InvitationSummary } from '@communione/services';
import { useCallback, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { Banner, Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { EXPIRY_CHOICES, USES_CHOICES, invitationLine, invitationLink } from '../adminRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Invitations'>;

type Expiry = (typeof EXPIRY_CHOICES)[number]['value'];
type Uses = (typeof USES_CHOICES)[number]['value'];
type Notice = { tone: 'danger' | 'success'; message: string };

/**
 * Invite people to the current community (members.invite). A new invitation's
 * code is shown ONCE, right after creating it (the server stores only its
 * hash); it is never written to logs or storage. The list shows active
 * invitations without their codes; revoking one stops it at once.
 */
export function InvitationsScreen(_props: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const { invitations } = useServices();
  const permissions = useCommunityPermissions();
  const [expiry, setExpiry] = useState<Expiry>('7 days');
  const [uses, setUses] = useState<Uses>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(
    () => invitations.list({ communityId: community.community_id }),
    [invitations, community.community_id],
  );
  const list = useAsync(load);

  if (!permissions.can('members.invite')) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Not available"
        message="You don't have permission to invite people here."
      />
    );
  }

  const create = async () => {
    setCreating(true);
    setNotice(null);
    try {
      setCreated(
        await invitations.create({ communityId: community.community_id, expiresIn: expiry, maxUses: uses }),
      );
      list.reload();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: errorMessage(thrown) });
    } finally {
      setCreating(false);
    }
  };

  const share = async (token: string) => {
    try {
      await Share.share({
        message: `Join ${community.name} on CommuniOne: ${invitationLink(token)}\nOr enter this code in the app: ${token}`,
      });
    } catch {
      setNotice({ tone: 'danger', message: 'Sharing is not available. Copy the code instead.' });
    }
  };

  const revoke = async (inv: InvitationSummary) => {
    setRevoking(inv.id);
    setNotice(null);
    try {
      await invitations.revoke(inv.id);
      setNotice({ tone: 'success', message: 'Invitation revoked. It can no longer be used.' });
      list.reload();
    } catch (thrown) {
      setNotice({ tone: 'danger', message: errorMessage(thrown) });
    } finally {
      setRevoking(null);
      setConfirmRevoke(null);
    }
  };

  return (
    <Screen testID="invitations-screen">
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          testID={notice.tone === 'danger' ? 'invitations-error' : 'invitations-done'}
        />
      ) : null}

      {created ? (
        <Card testID="new-invitation">
          <Text variant="heading" accessibilityRole="header">
            Invitation ready
          </Text>
          <Text tone="muted">
            Share it now: for your security the code is shown only once. Anyone with it can join{' '}
            {community.name} until it expires or you revoke it.
          </Text>
          <Text variant="label" tone="muted">
            Code
          </Text>
          <Text selectable testID="invitation-code" style={styles.code}>
            {created.token}
          </Text>
          <Text variant="label" tone="muted">
            Link
          </Text>
          <Text selectable testID="invitation-link" style={styles.code}>
            {invitationLink(created.token)}
          </Text>
          <Button title="Share invitation" icon="share-outline" onPress={() => void share(created.token)} />
          <Button title="Done" variant="ghost" onPress={() => setCreated(null)} />
        </Card>
      ) : (
        <Card testID="invitation-form">
          <Text variant="heading" accessibilityRole="header">
            New invitation
          </Text>
          <Text variant="label">Expires after</Text>
          <Choices<Expiry>
            choices={EXPIRY_CHOICES}
            value={expiry}
            onChange={setExpiry}
            label="Expires after"
          />
          <Text variant="label">Can be used by</Text>
          <Choices<Uses> choices={USES_CHOICES} value={uses} onChange={setUses} label="Can be used by" />
          <Button
            title="Create invitation"
            icon="person-add-outline"
            loading={creating}
            onPress={() => void create()}
          />
        </Card>
      )}

      <Text variant="heading" accessibilityRole="header">
        Active invitations
      </Text>
      {list.status === 'loading' ? (
        <LoadingState label="Loading invitations…" />
      ) : list.status === 'error' ? (
        <ErrorState
          title="Invitations could not be loaded"
          message={errorMessage(list.error)}
          onRetry={list.reload}
        />
      ) : list.data.length === 0 ? (
        <Text tone="muted" testID="no-invitations">
          No active invitations.
        </Text>
      ) : (
        list.data.map((inv) => (
          <Card key={inv.id} testID={`invitation-${inv.id}`}>
            <Text>{invitationLine(inv)}</Text>
            {confirmRevoke === inv.id ? (
              <View style={styles.row}>
                <Button
                  title="Revoke"
                  variant="danger"
                  fullWidth={false}
                  loading={revoking === inv.id}
                  onPress={() => void revoke(inv)}
                />
                <Button
                  title="Keep"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => setConfirmRevoke(null)}
                />
              </View>
            ) : (
              <Button
                title="Revoke invitation"
                variant="secondary"
                fullWidth={false}
                onPress={() => setConfirmRevoke(inv.id)}
              />
            )}
          </Card>
        ))
      )}
    </Screen>
  );
}

function Choices<T extends string | number | null>({
  choices,
  value,
  onChange,
  label,
}: {
  choices: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
  label: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {choices.map((c) => {
        const selected = c.value === value;
        return (
          <Pressable
            key={String(c.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={c.label}
            onPress={() => onChange(c.value)}
            style={[styles.choice, selected && styles.choiceSelected]}
          >
            <Text variant="label" tone={selected ? 'primary' : 'default'}>
              {c.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  code: {
    fontFamily: 'monospace',
    padding: t.spacing.sm,
    backgroundColor: t.colors.surfaceMuted,
    borderRadius: t.radius.md,
  },
  row: { flexDirection: 'row', gap: t.spacing.sm },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  choice: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  choiceSelected: { borderColor: t.colors.primary, backgroundColor: t.colors.surfaceMuted },
}));
