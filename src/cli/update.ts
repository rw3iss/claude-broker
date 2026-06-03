import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REMOTE_INSTALLER =
  'https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh';

export function updateCommand(): Command {
  return new Command('update')
    .description('Update this installation by re-running install.sh --update')
    .option('--ref <ref>', 'git ref (branch, tag, or SHA) to check out')
    .option('--repo <url>', 'override the source git URL')
    .option('--prefix <dir>', 'override the install prefix')
    .option('--bin-dir <dir>', 'override the bin symlink dir')
    .option(
      '--remote',
      'fetch and run the latest installer from GitHub instead of the local copy',
    )
    .action(
      async (opts: {
        ref?: string;
        repo?: string;
        prefix?: string;
        binDir?: string;
        remote?: boolean;
      }) => {
        const passthrough: string[] = ['--update'];
        if (opts.ref) passthrough.push('--ref', opts.ref);
        if (opts.repo) passthrough.push('--repo', opts.repo);
        if (opts.prefix) passthrough.push('--prefix', opts.prefix);
        if (opts.binDir) passthrough.push('--bin-dir', opts.binDir);

        if (opts.remote) {
          await runRemoteInstaller(passthrough);
          return;
        }

        const script = findInstallScript();
        if (!script) {
          console.error(
            'Could not find install.sh in this installation. ' +
              'Re-run with --remote to fetch it from GitHub, or invoke the curl one-liner manually:\n' +
              `  curl -fsSL ${REMOTE_INSTALLER} | bash -s -- --update`,
          );
          process.exit(1);
        }

        // install.sh prints the "restart the daemon" hint itself on --update.
        const child = spawn('bash', [script, ...passthrough], {
          stdio: 'inherit',
        });
        child.on('exit', (code) => process.exit(code ?? 0));
        child.on('error', (err) => {
          console.error(`failed to spawn bash: ${err.message}`);
          process.exit(1);
        });
      },
    );
}

function findInstallScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Probe likely locations relative to this file at runtime:
  //   - dist build:  dist/src/cli/update.js → ../../../install.sh
  //   - source tree: src/cli/update.ts      → ../../install.sh
  //   - dist-flat:   dist/cli/update.js     → ../../install.sh
  const candidates = [
    path.resolve(here, '..', '..', 'install.sh'),
    path.resolve(here, '..', '..', '..', 'install.sh'),
    path.resolve(here, '..', '..', '..', '..', 'install.sh'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runRemoteInstaller(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const pipeline = `curl -fsSL ${REMOTE_INSTALLER} | bash -s -- ${args
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(' ')}`;
    // install.sh prints the "restart the daemon" hint itself on --update.
    const child = spawn('bash', ['-c', pipeline], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error(`failed to spawn bash: ${err.message}`);
      process.exit(1);
    });
    void resolve();
  });
}
