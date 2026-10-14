// Quick alert presets: one tap picks what is happening and how serious it is.
// The severity is a suggestion the database re-checks (emergency needs
// alerts.manage, so it is offered only to people who manage alerts).
import type { IconName } from '@/components';
import type { Severity } from './alertRules';

export interface QuickAlertPreset {
  key: string;
  title: string;
  icon: IconName;
  severity: Severity;
  /** Used when the sender adds no details. */
  body: string;
}

export const QUICK_ALERTS: QuickAlertPreset[] = [
  {
    key: 'suspicious',
    title: 'Suspicious activity',
    icon: 'eye-outline',
    severity: 'warning',
    body: 'A neighbour reported suspicious activity. Stay alert and keep doors locked.',
  },
  {
    key: 'break-in',
    title: 'Break-in or theft',
    icon: 'lock-open-outline',
    severity: 'urgent',
    body: 'A neighbour reported a break-in or theft. Check your property and stay safe.',
  },
  {
    key: 'fire',
    title: 'Fire or smoke',
    icon: 'flame-outline',
    severity: 'urgent',
    body: 'A neighbour reported fire or smoke. Keep clear and follow emergency services.',
  },
  {
    key: 'medical',
    title: 'Medical help needed',
    icon: 'medkit-outline',
    severity: 'urgent',
    body: 'A neighbour needs medical help nearby.',
  },
  {
    key: 'road',
    title: 'Road hazard',
    icon: 'car-outline',
    severity: 'warning',
    body: 'A neighbour reported a hazard on the road. Take care when passing.',
  },
  {
    key: 'outage',
    title: 'Power or water outage',
    icon: 'flash-off-outline',
    severity: 'info',
    body: 'A neighbour reported a power or water outage.',
  },
  {
    key: 'animal',
    title: 'Lost or loose animal',
    icon: 'paw-outline',
    severity: 'info',
    body: 'A neighbour reported a lost or loose animal.',
  },
  {
    key: 'other',
    title: 'Something else',
    icon: 'alert-circle-outline',
    severity: 'warning',
    body: 'A neighbour sent an alert.',
  },
];

/** Managers (alerts.manage) can also raise a community emergency. */
export const EMERGENCY_PRESET: QuickAlertPreset = {
  key: 'emergency',
  title: 'Community emergency',
  icon: 'alert-circle',
  severity: 'emergency',
  body: 'Emergency in the community. Follow the instructions of emergency services.',
};

export const presetsFor = (can: (key: string) => boolean): QuickAlertPreset[] =>
  can('alerts.manage') ? [EMERGENCY_PRESET, ...QUICK_ALERTS] : QUICK_ALERTS;

/** Who the alert reaches, in words (urgent and emergency ignore mutes, migration 29). */
export function reachLine(severity: Severity, communityName: string): string {
  return severity === 'urgent' || severity === 'emergency'
    ? `Everyone in ${communityName} is notified at once, even if they muted alerts.`
    : `Members of ${communityName} who get alerts are notified at once.`;
}

/** "±12 m" */
export const accuracyLine = (metres: number | null | undefined) =>
  metres === null || metres === undefined ? null : `±${Math.max(1, Math.round(metres))} m`;
