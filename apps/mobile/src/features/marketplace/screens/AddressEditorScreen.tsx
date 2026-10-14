import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PARISHES, type Parish } from '@communione/services';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { Banner, Button, Screen, Text, TextField } from '@/components';
import { useServices } from '@/lib/dependencies';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorField } from '@/utils/errors';
import { ChipRow } from '../components/ChipRow';
import { orderError } from '../orderRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'AddressEditor'>;

/**
 * A delivery address in the user's private address book (Stage D). Only
 * the owner can read it; an order keeps a copy of the address it was
 * delivered to, shared with that order's seller only.
 */
export function AddressEditorScreen({ navigation }: Props) {
  const styles = useStyles();
  const { orders } = useServices();
  const [form, setForm] = useState({
    label: '',
    recipientName: '',
    phone: '',
    line1: '',
    line2: '',
    town: '',
    instructions: '',
  });
  const [parish, setParish] = useState<Parish>('Kingston');
  const [isDefault, setIsDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const set = (key: keyof typeof form) => (text: string) => setForm((f) => ({ ...f, [key]: text }));
  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await orders.saveAddress({
        label: form.label || null,
        recipientName: form.recipientName,
        phone: form.phone,
        line1: form.line1,
        line2: form.line2 || null,
        town: form.town,
        parish,
        instructions: form.instructions || null,
        isDefault,
      });
      navigation.goBack();
    } catch (thrown) {
      setError({ message: orderError(thrown), field: errorField(thrown) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen testID="address-editor">
      {error && !error.field ? <Banner tone="danger" message={error.message} /> : null}
      <TextField
        label="Label (optional)"
        placeholder="Home, Work…"
        value={form.label}
        onChangeText={set('label')}
      />
      <TextField
        label="Recipient name"
        value={form.recipientName}
        onChangeText={set('recipientName')}
        error={fieldError('recipientName')}
        testID="address-name"
      />
      <TextField
        label="Phone"
        value={form.phone}
        onChangeText={set('phone')}
        keyboardType="phone-pad"
        error={fieldError('phone')}
        testID="address-phone"
      />
      <TextField
        label="Street address"
        value={form.line1}
        onChangeText={set('line1')}
        error={fieldError('line1')}
        testID="address-line1"
      />
      <TextField label="Apartment, district (optional)" value={form.line2} onChangeText={set('line2')} />
      <TextField
        label="Town"
        value={form.town}
        onChangeText={set('town')}
        error={fieldError('town')}
        testID="address-town"
      />
      <Text variant="label">Parish</Text>
      <ChipRow<Parish>
        label="Parish"
        options={PARISHES.map((p) => ({ value: p, label: p }))}
        value={parish}
        onChange={setParish}
        testID="address-parish"
      />
      <TextField
        label="Directions for the seller (optional)"
        value={form.instructions}
        onChangeText={set('instructions')}
        multiline
      />
      <View style={styles.row}>
        <Text style={styles.flex}>Use as my default address</Text>
        <Switch
          value={isDefault}
          onValueChange={setIsDefault}
          accessibilityLabel="Use as my default address"
          testID="address-default"
        />
      </View>
      <Button title="Save address" loading={saving} onPress={() => void save()} testID="address-save" />
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  flex: { flex: 1 },
}));
