import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isServiceError, type UploadRules } from '@communione/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, ErrorState, Icon, LoadingState, Screen, Text, TextField } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { useAsync } from '@/hooks/useAsync';
import { useDependencies } from '@/lib/dependencies';
import type { PickedFile } from '@/lib/media';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import {
  checkFile,
  documentError,
  fileKind,
  formatSize,
  suggestedName,
  supportedTypes,
} from '../documentRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'DocumentUpload'>;

type Step = 'idle' | 'reserving' | 'sending' | 'verifying' | 'failed' | 'cancelling';

/**
 * Uploads one document to the current community, in three server-checked
 * steps: reserve (permission, type, size, folder; the server picks the
 * storage path), send the file to that path (progress; can be cancelled),
 * then complete (the server checks what was stored). A failure keeps what
 * already succeeded, so "Try again" resumes without a second document.
 */
export function DocumentUploadScreen(props: Props) {
  const { services } = useDependencies();
  const loadRules = useCallback(() => services.documents.uploadRules(), [services]);
  const rules = useAsync(loadRules);
  if (rules.status === 'loading') return <LoadingState label="Loading…" />;
  if (rules.status === 'error') {
    return (
      <ErrorState
        title="Uploads are not available"
        message={errorMessage(rules.error)}
        onRetry={rules.reload}
      />
    );
  }
  return <Upload {...props} rules={rules.data} />;
}

function Upload({ navigation, route, rules }: Props & { rules: UploadRules }) {
  const styles = useStyles();
  const { services, media } = useDependencies();
  const { documents } = services;
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const folderId = route.params?.folderId ?? null;
  const [file, setFile] = useState<PickedFile | null>(null);
  const [name, setName] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const bytes = useRef<Uint8Array | null>(null);
  const controller = useRef<AbortController | null>(null);
  const reservation = useRef<string | null>(null);
  const working = step === 'reserving' || step === 'sending' || step === 'verifying' || step === 'cancelling';

  // Leaving before the upload completed: stop it and discard the reservation (best effort;
  // the purge job removes anything left).
  useEffect(
    () => () => {
      controller.current?.abort();
      if (reservation.current) void documents.cancelUpload(reservation.current).catch(() => undefined);
    },
    [documents],
  );

  const choose = async () => {
    setProblem(null);
    setNotice(null);
    let picked: PickedFile | null;
    try {
      picked = await media.pickDocument();
    } catch (thrown) {
      setProblem(errorMessage(thrown));
      return;
    }
    if (!picked) return;
    const check = checkFile(picked, rules);
    if (!check.ok) {
      setFile(null);
      setProblem(check.message);
      return;
    }
    bytes.current = null;
    setFile(picked);
    setName(suggestedName(picked.name));
  };

  const upload = async () => {
    if (!file) return;
    const check = checkFile(file, rules);
    if (!check.ok) return setProblem(check.message);
    setProblem(null);
    setNotice(null);
    let id = pendingId;
    try {
      if (!bytes.current) {
        const content = await file.read();
        // The picker may not report a size: check what was read.
        const real = checkFile({ ...file, size: content.byteLength }, rules);
        if (!real.ok) return setProblem(real.message);
        bytes.current = content;
      }
      if (!id) {
        setStep('reserving');
        const pending = await documents.beginUpload({
          communityId: community.community_id,
          name: name.trim(),
          mimeType: check.mimeType,
          size: bytes.current.byteLength,
          folderId,
          visibility: restricted ? 'managers' : 'members',
        });
        id = pending.documentId;
        reservation.current = id;
        setPendingId(id);
      }
      if (!sent) {
        setStep('sending');
        setProgress(0);
        controller.current = new AbortController();
        await documents.sendFile(id, bytes.current, {
          signal: controller.current.signal,
          onProgress: (done, total) => setProgress(total > 0 ? Math.round((done / total) * 100) : 0),
        });
        controller.current = null;
        setSent(true);
      }
      setStep('verifying');
      const doc = await documents.completeUpload(id);
      reservation.current = null;
      navigation.replace('DocumentDetail', { documentId: doc.id });
    } catch (thrown) {
      controller.current = null;
      if (isServiceError(thrown) && thrown.details.cancelled) return discard(id, 'Upload cancelled.');
      setStep('failed');
      setProblem(documentError(thrown));
    }
  };

  const discard = async (id: string | null, message: string | null) => {
    setStep('cancelling');
    if (id) await documents.cancelUpload(id).catch(() => undefined);
    reservation.current = null;
    bytes.current = null;
    setPendingId(null);
    setSent(false);
    setProgress(0);
    setStep('idle');
    setProblem(null);
    setNotice(message);
  };

  const fileCheck = file ? checkFile(file, rules) : null;
  const kind = fileCheck?.ok ? fileKind(fileCheck.extension) : null;
  const status =
    step === 'reserving'
      ? 'Preparing…'
      : step === 'sending'
        ? `Uploading… ${progress}%`
        : step === 'verifying'
          ? 'Checking the file…'
          : step === 'cancelling'
            ? 'Cancelling…'
            : null;

  return (
    <Screen testID="document-upload-screen">
      <Text tone="muted" testID="document-upload-rules">
        {`Supported: ${supportedTypes(rules)}. Up to ${formatSize(rules.maxFileSize)}.`}
      </Text>
      {route.params?.folderName ? (
        <View style={styles.row}>
          <Icon name="folder-outline" size={18} color="textMuted" />
          <Text variant="label" tone="muted">
            {`Into ${route.params.folderName}`}
          </Text>
        </View>
      ) : null}

      {file && kind ? (
        <View style={styles.file} testID="document-upload-file">
          <Icon name={kind.icon} size={28} color="primary" />
          <View style={styles.flex}>
            <Text variant="label" numberOfLines={2}>
              {file.name}
            </Text>
            <Text variant="caption" tone="muted">
              {[kind.label, file.size !== null ? formatSize(file.size) : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      ) : null}
      <Button
        title={file ? 'Choose another file' : 'Choose a file'}
        variant={file ? 'secondary' : 'primary'}
        onPress={() => void choose()}
        disabled={working || pendingId !== null}
      />

      {file ? (
        <>
          <TextField
            label="Name"
            value={name}
            onChangeText={setName}
            maxLength={255}
            editable={!working && pendingId === null}
          />
          {permissions.can('documents.manage') ? (
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel="Managers only"
              accessibilityState={{ checked: restricted, disabled: working || pendingId !== null }}
              disabled={working || pendingId !== null}
              onPress={() => setRestricted((r) => !r)}
              style={styles.row}
            >
              <Icon name={restricted ? 'checkbox' : 'square-outline'} size={22} color="primary" />
              <Text style={styles.flex}>Managers only (members won&apos;t see it)</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {status ? (
        <View
          style={styles.progress}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={status}
          accessibilityValue={step === 'sending' ? { min: 0, max: 100, now: progress } : undefined}
        >
          <Text variant="caption" tone="muted" testID="document-upload-progress">
            {status}
          </Text>
          <View style={styles.track}>
            <View
              style={[
                styles.bar,
                { width: `${step === 'sending' ? progress : step === 'reserving' ? 0 : 100}%` },
              ]}
            />
          </View>
        </View>
      ) : null}

      {problem ? <Banner tone="danger" message={problem} testID="document-upload-error" /> : null}
      {notice ? <Banner message={notice} testID="document-upload-notice" /> : null}

      {step === 'sending' ? (
        <Button title="Cancel upload" variant="secondary" onPress={() => controller.current?.abort()} />
      ) : step === 'failed' ? (
        <View style={styles.actions}>
          <Button title="Try again" fullWidth={false} onPress={() => void upload()} />
          <Button
            title="Discard"
            variant="ghost"
            fullWidth={false}
            onPress={() => void discard(pendingId, null)}
          />
        </View>
      ) : (
        <Button
          title="Upload"
          onPress={() => void upload()}
          loading={working}
          disabled={!file || !name.trim() || working}
        />
      )}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, minHeight: 44 },
  flex: { flex: 1 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  progress: { gap: t.spacing.xs },
  track: { height: 6, borderRadius: 3, backgroundColor: t.colors.surfaceMuted, overflow: 'hidden' },
  bar: { height: 6, backgroundColor: t.colors.primary },
  actions: { flexDirection: 'row', gap: t.spacing.sm },
}));
