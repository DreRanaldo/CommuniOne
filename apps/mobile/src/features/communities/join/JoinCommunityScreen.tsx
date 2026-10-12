import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ErrorCode,
  isServiceError,
  parseInvitationToken,
  type InvitationPreview,
} from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Banner, Button, Card, LoadingState, Screen, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { RootStackParamList } from '@/types/navigation';
import { formatDate } from '@/utils/format';
import { CommunityLogo } from '../components/CommunityLogo';
import { useCurrentCommunity } from '../CurrentCommunityProvider';
import { typeLabel } from '../selection';
import { invitationProblem, type InvitationProblem } from './invitationErrors';

type Props = NativeStackScreenProps<RootStackParamList, 'JoinCommunity'>;

type Step =
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'preview'; preview: InvitationPreview }
  | { kind: 'problem'; problem: InvitationProblem };

/**
 * Joining with an invitation, in two server steps:
 *   1. services.invitations.preview(token): validates it and shows the
 *      community WITHOUT joining (preview_invitation(): same checks as
 *      redemption, consumes nothing);
 *   2. services.invitations.redeem(token) when the user accepts
 *      (redeem_invitation(): atomic, default Member role).
 * The token arrives from a link (communione://join?token=…), a pasted code,
 * or, later, a scanned QR code (the same link). It is a secret: it is kept in
 * memory only, removed from the route, never displayed back or logged.
 */
export function JoinCommunityScreen({ navigation, route }: Props) {
  const styles = useStyles();
  const { invitations, communities } = useServices();
  const { select } = useCurrentCommunity();
  const token = useRef<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  // A link opens straight into the check; otherwise the user enters a code.
  const [step, setStep] = useState<Step>(() =>
    route.params?.token ? { kind: 'checking' } : { kind: 'enter' },
  );
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  /** Asks the server about a (well-formed) token; never joins. */
  const previewStep = useCallback(
    async (parsed: string): Promise<Step> => {
      token.current = parsed;
      try {
        return { kind: 'preview', preview: await invitations.preview(parsed) };
      } catch (error) {
        return { kind: 'problem', problem: invitationProblem(error) };
      }
    },
    [invitations],
  );

  const check = async (input: string) => {
    setCodeError(null);
    let parsed: string;
    try {
      parsed = parseInvitationToken(input);
    } catch {
      setCodeError('This is not a valid invitation code or link.');
      return;
    }
    setCode('');
    setStep({ kind: 'checking' });
    setStep(await previewStep(parsed));
  };

  // A token from a link: take it out of the route (navigation state) and check it.
  const fromLink = route.params?.token;
  useEffect(() => {
    if (!fromLink) return;
    navigation.setParams({ token: undefined });
    let parsed: string | null = null;
    try {
      parsed = parseInvitationToken(fromLink);
    } catch {
      parsed = null;
    }
    const next: Promise<Step> = parsed
      ? previewStep(parsed)
      : Promise.resolve({
          kind: 'problem',
          problem: {
            title: 'Invitation not found',
            message: "This link isn't a valid invitation.",
            retry: false,
          },
        });
    // Not cancelled when the param is cleared (that re-runs this effect); a
    // result arriving after the screen closed is simply ignored by React.
    void next.then(setStep);
  }, [fromLink, navigation, previewStep]);

  const openCommunity = async (communityId: string) => {
    await select(communityId);
    navigation.popTo('App', { screen: 'Home' });
  };

  const join = async (preview: InvitationPreview) => {
    if (!token.current) return;
    setJoining(true);
    setJoinError(null);
    try {
      const joined = await invitations.redeem(token.current);
      token.current = null;
      await openCommunity(joined.communityId);
    } catch (error) {
      if (isServiceError(error) && error.code === ErrorCode.Conflict) {
        // Joined meanwhile (e.g. on another device): show it as such.
        setStep({ kind: 'preview', preview: { ...preview, membershipStatus: 'active' } });
      } else {
        const problem = invitationProblem(error);
        if (problem.retry) setJoinError(problem.message);
        else setStep({ kind: 'problem', problem });
      }
    } finally {
      setJoining(false);
    }
  };

  const startOver = () => {
    token.current = null;
    setJoinError(null);
    setStep({ kind: 'enter' });
  };

  if (step.kind === 'checking') return <LoadingState label="Checking your invitation…" />;

  if (step.kind === 'problem') {
    const { problem } = step;
    return (
      <Screen testID="join-problem">
        <Banner tone="danger" title={problem.title} message={problem.message} testID="join-error" />
        {problem.retry ? (
          <Button
            title="Try again"
            onPress={() => {
              if (token.current) void check(token.current);
            }}
          />
        ) : null}
        <Button title="Enter another code" variant="secondary" onPress={startOver} />
        <Button title="Close" variant="ghost" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  if (step.kind === 'preview') {
    const { preview } = step;
    const cover = communities.imageUrl(preview, 'cover');
    const status = preview.membershipStatus;
    const alreadyMember = status === 'active';
    const suspended = status === 'suspended';
    return (
      <Screen testID="join-preview">
        <Card>
          {cover ? (
            <Image
              source={{ uri: cover }}
              style={styles.cover}
              accessibilityRole="image"
              accessibilityLabel={`${preview.name} cover image`}
              testID="invitation-cover"
            />
          ) : null}
          <View style={styles.header}>
            <CommunityLogo community={preview} size={64} />
            <View style={styles.headerText}>
              <Text variant="title">{preview.name}</Text>
              <Text tone="muted">
                {typeLabel(preview.type)} · {preview.memberCount}{' '}
                {preview.memberCount === 1 ? 'member' : 'members'}
              </Text>
            </View>
          </View>
          {preview.description ? <Text>{preview.description}</Text> : null}
          <Text variant="caption" tone="muted">
            Invitation valid until {formatDate(preview.expiresAt)}
          </Text>
        </Card>

        {alreadyMember ? (
          <>
            <Banner
              title="You're already a member"
              message={`You belong to ${preview.name}. This invitation was not used.`}
              testID="already-member"
            />
            <Button title={`Open ${preview.name}`} onPress={() => void openCommunity(preview.communityId)} />
          </>
        ) : suspended ? (
          <Banner
            tone="danger"
            title="Membership suspended"
            message="Your membership in this community is suspended. An invitation cannot lift a suspension."
            testID="suspended-member"
          />
        ) : (
          <>
            {joinError ? <Banner tone="danger" message={joinError} testID="join-failed" /> : null}
            <Button title={`Join ${preview.name}`} onPress={() => void join(preview)} loading={joining} />
          </>
        )}
        <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={joining} />
      </Screen>
    );
  }

  return (
    <Screen testID="join-community-screen">
      <Text tone="muted">
        Paste the invitation code or link you received. You will see the community before you join.
      </Text>
      <TextField
        label="Invitation code or link"
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        error={codeError}
        onSubmitEditing={() => void check(code)}
      />
      <Button title="Continue" onPress={() => void check(code)} disabled={!code.trim()} />
      <Text variant="caption" tone="muted">
        Opening an invitation link on this device works too.
      </Text>
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  cover: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceMuted,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  headerText: { flex: 1, gap: t.spacing.xxs },
}));
