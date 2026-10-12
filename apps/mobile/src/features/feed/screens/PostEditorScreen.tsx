import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ErrorCode, isServiceError, type Post } from '@communione/services';
import { useCallback, useLayoutEffect, useState } from 'react';
import { Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useAsync } from '@/hooks/useAsync';
import { useServices } from '@/lib/dependencies';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';

type Props = NativeStackScreenProps<CommunityStackParamList, 'PostEditor'>;

export const POST_MAX_LENGTH = 10_000;

/** Writes a new post, or edits one (`postId`). The post being edited is loaded from the server. */
export function PostEditorScreen(props: Props) {
  const postId = props.route.params?.postId;
  const { posts } = useServices();
  const community = useCommunity();
  const load = useCallback(async (): Promise<Post | null> => {
    if (!postId) return null;
    const post = await posts.get(postId);
    // Only posts of the current community are edited here.
    if (post.community_id !== community.community_id) throw new Error('not in this community');
    return post;
  }, [posts, postId, community.community_id]);
  const existing = useAsync(load);

  if (existing.status === 'loading') return <LoadingState label="Loading the post…" />;
  if (existing.status === 'error') {
    const notFound = !isServiceError(existing.error) || existing.error.code === ErrorCode.NotFound;
    return (
      <ErrorState
        title={notFound ? 'This post is not available' : 'The post could not be loaded'}
        message={notFound ? 'It may have been deleted or hidden.' : errorMessage(existing.error)}
        onRetry={notFound ? undefined : existing.reload}
      />
    );
  }
  return <PostEditor {...props} existing={existing.data} />;
}

function PostEditor({ navigation, existing }: Props & { existing: Post | null }) {
  const { posts } = useServices();
  const community = useCommunity();
  const [body, setBody] = useState(existing?.body ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = existing !== null;
  const length = [...body].length;

  useLayoutEffect(() => {
    navigation.setOptions({ title: editing ? 'Edit post' : 'New post' });
  }, [navigation, editing]);

  const save = async () => {
    setFormError(null);
    if (!body.trim()) {
      setFieldError('Write something first.');
      return;
    }
    if (length > POST_MAX_LENGTH) {
      setFieldError(`Use at most ${POST_MAX_LENGTH.toLocaleString()} characters.`);
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      // The community comes from the current community; authorship from the session (server side).
      if (existing) await posts.edit(existing.id, body);
      else await posts.create({ communityId: community.community_id, body });
      navigation.goBack();
    } catch (error) {
      if (errorField(error) === 'body') setFieldError(errorMessage(error));
      else if (
        isServiceError(error) &&
        (error.code === ErrorCode.Forbidden || error.code === ErrorCode.NotFound)
      )
        setFormError(editing ? "You can't edit this post." : "You can't post in this community.");
      else setFormError(errorMessage(error));
      setSaving(false);
    }
  };

  return (
    <Screen testID="post-editor-screen">
      <Text tone="muted">Posting in {community.name}</Text>
      {formError ? <Banner tone="danger" message={formError} testID="post-editor-error" /> : null}
      <TextField
        label={editing ? 'Your post' : 'What would you like to share?'}
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus
        error={fieldError}
        hint={`${length.toLocaleString()} / ${POST_MAX_LENGTH.toLocaleString()}`}
      />
      <Button title={editing ? 'Save changes' : 'Post'} onPress={() => void save()} loading={saving} />
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={saving} />
    </Screen>
  );
}
