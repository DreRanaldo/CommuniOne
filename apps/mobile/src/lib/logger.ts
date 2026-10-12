// The app logger: the service layer's redacting console logger in
// development, silent in release builds (wire a crash/telemetry sink here
// later; it must keep using redact()).
import { consoleLogger, silentLogger, type Logger } from '@communione/services';

export const logger: Logger = __DEV__ ? consoleLogger : silentLogger;
