const winston = require('winston');
const path = require('path');
const chalk = require('chalk');

const SENSITIVE_FIELD = /(?:api[_-]?key|authorization|auth(?:orization)?[_-]?header|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|password|passwd|secret|credential|cookie)/i;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|credential|cookie)\b(\s*[:=]\s*)(?:Bearer\s+)?("[^"]*"|'[^']*'|[^\s,;&}"']+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function sanitizeString(value) {
  return value
    .replace(SECRET_ASSIGNMENT, (_match, field, separator) => `${field}${separator}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]');
}

function sanitizeLogValue(value, fieldName = '', seen = new WeakSet()) {
  if (SENSITIVE_FIELD.test(fieldName)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const safeError = {
      name: sanitizeLogValue(value.name, 'name', seen),
      message: sanitizeLogValue(value.message, 'message', seen),
      stack: sanitizeLogValue(value.stack, 'stack', seen)
    };
    for (const [key, nested] of Object.entries(value)) {
      safeError[key] = sanitizeLogValue(nested, key, seen);
    }
    return safeError;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogValue(item, '', seen));
  }

  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    sanitizeLogValue(nested, key, seen)
  ]));
}

class Logger {
  constructor(component = 'System') {
    this.component = component;
    this.winston = this.createWinstonLogger();
  }

  createWinstonLogger() {
    const logDir = process.env.YOUTUBE_AUTOMATION_LOG_DIR || path.join(__dirname, '..', 'logs');
    
    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { component: this.component },
      transports: [
        // Write all logs to combined.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'combined.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 5,
        }),
        
        // Write error logs to error.log
        new winston.transports.File({ 
          filename: path.join(logDir, 'error.log'), 
          level: 'error',
          maxsize: 5242880, // 5MB
          maxFiles: 3,
        }),
        
        // Write agent-specific logs
        new winston.transports.File({
          filename: path.join(logDir, `${this.component.toLowerCase()}.log`),
          maxsize: 2097152, // 2MB
          maxFiles: 3,
        })
      ]
    });
  }

  info(message, ...args) {
    const safeMessage = sanitizeLogValue(message);
    this.winston.info(safeMessage, ...sanitizeLogValue(args));
    console.log(this.formatConsoleMessage('INFO', safeMessage, chalk.blue));
  }

  success(message, ...args) {
    const safeMessage = sanitizeLogValue(message);
    this.winston.info(safeMessage, ...sanitizeLogValue(args));
    console.log(this.formatConsoleMessage('SUCCESS', safeMessage, chalk.green));
  }

  warn(message, ...args) {
    const safeMessage = sanitizeLogValue(message);
    this.winston.warn(safeMessage, ...sanitizeLogValue(args));
    console.log(this.formatConsoleMessage('WARN', safeMessage, chalk.yellow));
  }

  error(message, error = null, ...args) {
    const safeMessage = sanitizeLogValue(message);
    if (error) {
      this.winston.error(safeMessage, sanitizeLogValue({ error: error.message, stack: error.stack, ...args }));
    } else {
      this.winston.error(safeMessage, ...sanitizeLogValue([error, ...args].filter(value => value !== null)));
    }
    console.log(this.formatConsoleMessage('ERROR', safeMessage, chalk.red));
    if (error && process.env.NODE_ENV !== 'production') {
      console.error(chalk.red(sanitizeLogValue(error.stack)));
    }
  }

  debug(message, ...args) {
    const safeMessage = sanitizeLogValue(message);
    this.winston.debug(safeMessage, ...sanitizeLogValue(args));
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatConsoleMessage('DEBUG', safeMessage, chalk.gray));
    }
  }

  formatConsoleMessage(level, message, colorFunc) {
    const timestamp = new Date().toLocaleTimeString();
    const componentTag = chalk.cyan(`[${this.component}]`);
    const levelTag = colorFunc(`[${level}]`);
    
    return `${chalk.gray(timestamp)} ${componentTag} ${levelTag} ${message}`;
  }

  // Method to create specialized loggers for different purposes
  static createAgentLogger(agentName) {
    return new Logger(agentName);
  }

  static createSystemLogger() {
    return new Logger('System');
  }

  static createAPILogger() {
    return new Logger('API');
  }

  // Performance logging
  startTimer(label) {
    const startTime = Date.now();
    return {
      end: () => {
        const duration = Date.now() - startTime;
        this.info(`${label} completed in ${duration}ms`);
        return duration;
      }
    };
  }

  // Structured logging for important events
  logEvent(eventType, data = {}) {
    this.winston.info('System Event', sanitizeLogValue({
      eventType,
      timestamp: new Date().toISOString(),
      ...data
    }));
  }

  // Log content generation pipeline
  logContentPipeline(stage, contentId, status, data = {}) {
    this.winston.info('Content Pipeline', sanitizeLogValue({
      stage,
      contentId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    }));
  }

  // Log publishing events
  logPublishing(action, videoId, status, data = {}) {
    this.winston.info('Publishing Event', sanitizeLogValue({
      action,
      videoId,
      status,
      timestamp: new Date().toISOString(),
      ...data
    }));
  }

  // Log analytics events
  logAnalytics(videoId, metrics, insights = []) {
    this.winston.info('Analytics Update', sanitizeLogValue({
      videoId,
      metrics,
      insights,
      timestamp: new Date().toISOString()
    }));
  }

  // Log errors with context
  logErrorWithContext(error, context = {}) {
    this.winston.error('System Error', sanitizeLogValue({
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name
      },
      context,
      timestamp: new Date().toISOString()
    }));
  }
}

module.exports = { Logger };
