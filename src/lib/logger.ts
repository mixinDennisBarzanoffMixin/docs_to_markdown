import { appendFileSync } from 'fs';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

class Logger {
  private logFile = 'debug.log';

  private log(level: LogLevel, message: string, data?: any) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    }) + '\n';
    
    try {
      appendFileSync(this.logFile, entry);
    } catch (e) {
      // Silently fail if log cannot be written
    }
  }

  debug(message: string, data?: any) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: any) {
    this.log(LogLevel.ERROR, message, data);
  }
}

export const logger = new Logger();

