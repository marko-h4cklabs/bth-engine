import chalk from 'chalk';

function timestamp(): string {
  return chalk.gray(new Date().toISOString());
}

export const logger = {
  info(message: string, ...args: unknown[]): void {
    console.log(`${timestamp()} ${chalk.blue('INFO')}  ${message}`, ...args);
  },

  success(message: string, ...args: unknown[]): void {
    console.log(`${timestamp()} ${chalk.green('OK')}    ${message}`, ...args);
  },

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${timestamp()} ${chalk.yellow('WARN')}  ${message}`, ...args);
  },

  error(message: string, ...args: unknown[]): void {
    console.error(`${timestamp()} ${chalk.red('ERROR')} ${message}`, ...args);
  },

  step(step: number, total: number, message: string): void {
    const label = chalk.cyan(`[${step}/${total}]`);
    console.log(`${timestamp()} ${label} ${chalk.bold(message)}`);
  },

  section(title: string): void {
    const line = '─'.repeat(60);
    console.log(`\n${chalk.dim(line)}`);
    console.log(chalk.bold.white(`  ${title}`));
    console.log(`${chalk.dim(line)}\n`);
  },

  data(label: string, value: unknown): void {
    const formatted = typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value);
    console.log(`  ${chalk.dim(label + ':')} ${chalk.white(formatted)}`);
  },
};
