import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ProfilePatch } from '@communione/services';
import { useState } from 'react';
import { View } from 'react-native';
import { Avatar, Banner, Button, ErrorState, LoadingState, Screen, Text, TextField } from '@/components';
import { useDependencies, useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { ProfileStackParamList } from '@/types/navigation';
import { errorField, errorMessage } from '@/utils/errors';
import { displayNameOf, useMyProfile, type MyProfile } from '../hooks/useMyProfile';
import { validateProfileForm, type ProfileForm, type ProfileFormErrors } from '../validation';

type Props = NativeStackScreenProps<ProfileStackParamList, 'EditProfile'>;

export function EditProfileScreen(props: Props) {
  const me = useMyProfile();
  if (me.status === 'loading') return <LoadingState label="Loading your profile…" />;
  if (me.status === 'error') {
    return (
      <ErrorState
        title="Your profile could not be loaded"
        message={errorMessage(me.error)}
        onRetry={me.reload}
      />
    );
  }
  return <EditProfileForm {...props} initial={me.data} />;
}

const formFrom = ({ profile, phone }: MyProfile): ProfileForm => ({
  displayName: profile.display_name ?? '',
  firstName: profile.first_name ?? '',
  lastName: profile.last_name ?? '',
  bio: profile.bio ?? '',
  phone: phone ?? '',
});

const orNull = (value: string) => value.trim() || null;
const FIELDS = ['displayName', 'firstName', 'lastName', 'bio', 'phone'] as const;

/**
 * Edits the caller's own profile. Text fields are saved together with
 * "Save changes"; the avatar is uploaded (or removed) as soon as it is chosen.
 * Everything goes through services.auth, which only ever writes the session
 * user's own rows; the database enforces the same.
 */
function EditProfileForm({ navigation, initial }: Props & { initial: MyProfile }) {
  const styles = useStyles();
  const { auth } = useServices();
  const { media } = useDependencies();
  const [saved, setSaved] = useState(() => formFrom(initial));
  const [form, setForm] = useState(saved);
  const [errors, setErrors] = useState<ProfileFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [avatar, setAvatar] = useState({ path: initial.profile.avatar_path, uri: initial.avatarUri });
  const [avatarBusy, setAvatarBusy] = useState<'choose' | 'remove' | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const set = (field: keyof ProfileForm) => (value: string) => setForm((f) => ({ ...f, [field]: value }));
  const changed = FIELDS.filter((field) => form[field].trim() !== saved[field].trim());

  const chooseAvatar = async () => {
    setAvatarError(null);
    setAvatarBusy('choose');
    try {
      const picked = await media.pickImage('avatar');
      if (!picked) return;
      const profile = await auth.uploadMyAvatar({ file: picked.bytes, mimeType: picked.mimeType });
      // Show the local image now; the profile screen loads a signed URL.
      setAvatar({ path: profile.avatar_path, uri: picked.uri });
    } catch (error) {
      setAvatarError(errorMessage(error));
    } finally {
      setAvatarBusy(null);
    }
  };

  const removeAvatar = async () => {
    setAvatarError(null);
    setAvatarBusy('remove');
    try {
      await auth.removeMyAvatar();
      setAvatar({ path: null, uri: null });
    } catch (error) {
      setAvatarError(errorMessage(error));
    } finally {
      setAvatarBusy(null);
    }
  };

  const save = async () => {
    const found = validateProfileForm(form);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    if (changed.length === 0) {
      navigation.goBack();
      return;
    }
    setSaving(true);
    try {
      const patch: ProfilePatch = {};
      if (changed.includes('displayName')) patch.displayName = orNull(form.displayName);
      if (changed.includes('firstName')) patch.firstName = orNull(form.firstName);
      if (changed.includes('lastName')) patch.lastName = orNull(form.lastName);
      if (changed.includes('bio')) patch.bio = orNull(form.bio);
      if (Object.keys(patch).length > 0) {
        await auth.updateMyProfile(patch);
        // If the phone number fails next, these fields are already saved.
        setSaved((before) => ({ ...form, phone: before.phone }));
      }
      if (changed.includes('phone')) await auth.setMyPhone(orNull(form.phone));
      navigation.goBack();
    } catch (error) {
      const field = errorField(error);
      if (field && (FIELDS as readonly string[]).includes(field)) setErrors({ [field]: errorMessage(error) });
      else setFormError(errorMessage(error));
      setSaving(false);
    }
  };

  const name = orNull(form.displayName) ?? displayNameOf(initial.profile);

  return (
    <Screen testID="edit-profile-screen">
      <View style={styles.avatar}>
        <Avatar uri={avatar.uri} name={name} size={96} />
        <View style={styles.avatarActions}>
          <Button
            title={avatar.uri ? 'Change photo' : 'Add photo'}
            variant="secondary"
            icon="image-outline"
            fullWidth={false}
            onPress={chooseAvatar}
            loading={avatarBusy === 'choose'}
            disabled={avatarBusy !== null || saving}
          />
          {avatar.path || avatar.uri ? (
            <Button
              title="Remove photo"
              variant="ghost"
              fullWidth={false}
              onPress={removeAvatar}
              loading={avatarBusy === 'remove'}
              disabled={avatarBusy !== null || saving}
            />
          ) : null}
        </View>
        <Text variant="caption" tone="muted" align="center">
          Visible to members of your communities. JPEG, PNG or WebP, up to 2 MB.
        </Text>
        {avatarError ? <Banner tone="danger" message={avatarError} testID="avatar-error" /> : null}
      </View>

      {formError ? <Banner tone="danger" message={formError} testID="edit-profile-error" /> : null}
      <TextField
        label="Display name"
        value={form.displayName}
        onChangeText={set('displayName')}
        hint="How your name appears to other members."
        autoComplete="nickname"
        error={errors.displayName}
      />
      <TextField
        label="First name"
        value={form.firstName}
        onChangeText={set('firstName')}
        autoComplete="given-name"
        textContentType="givenName"
        error={errors.firstName}
      />
      <TextField
        label="Last name"
        value={form.lastName}
        onChangeText={set('lastName')}
        autoComplete="family-name"
        textContentType="familyName"
        error={errors.lastName}
      />
      <TextField
        label="Bio"
        value={form.bio}
        onChangeText={set('bio')}
        multiline
        hint="Up to 1000 characters."
        error={errors.bio}
      />
      <TextField
        label="Phone number"
        value={form.phone}
        onChangeText={set('phone')}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        hint="Private: only you can see it."
        error={errors.phone}
      />
      <Button title="Save changes" onPress={save} loading={saving} disabled={avatarBusy !== null} />
      <Button title="Cancel" variant="ghost" onPress={() => navigation.goBack()} disabled={saving} />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  avatar: { alignItems: 'center', gap: t.spacing.sm },
  avatarActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.spacing.sm },
}));
