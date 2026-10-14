// The device's current position, read ONLY when the user asks to share it
// (e.g. "Share my location" on a quick alert). Foreground ("while using the
// app") permission only: the app never tracks location in the background
// and never reads it without a tap.
import * as Location from 'expo-location';

export interface CurrentPosition {
  latitude: number;
  longitude: number;
  /** Metres, when the device reports it. */
  accuracy: number | null;
}

export class LocationUnavailableError extends Error {
  constructor(readonly reason: 'denied' | 'unavailable') {
    super(
      reason === 'denied'
        ? 'Location permission was not given. You can allow it in your device settings.'
        : 'Your location could not be found. Check that location services are on.',
    );
  }
}

export interface LocationSource {
  /** Asks for permission if needed, then reads one position. */
  current(): Promise<CurrentPosition>;
}

export const expoLocationSource: LocationSource = {
  async current() {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== 'granted') throw new LocationUnavailableError('denied');
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy ?? null,
      };
    } catch {
      throw new LocationUnavailableError('unavailable');
    }
  },
};

/** A link that opens the position in the device's maps (no API key, nothing embedded). */
export const mapsLink = (latitude: number, longitude: number) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
