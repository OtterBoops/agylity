import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function findFiles(dir, exts) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

export async function checkCanonicalClasses(rootDir = '.') {
  const frontendDir = path.resolve(rootDir, 'frontend');
  const srcDir = path.join(frontendDir, 'src');
  const files = findFiles(srcDir, ['.tsx', '.html', '.jsx']);
  const classRegex = /class(?:Name)?=["'`]([^"'`]+)["'`]/g;

  const items = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const rawClass = match[1].trim();
      if (
        rawClass &&
        !rawClass.includes('${') &&
        !rawClass.includes('?') &&
        !rawClass.includes(':')
      ) {
        items.push({ file: path.relative(rootDir, file), rawClass });
      }
    }
  }

  if (items.length === 0) return { passed: true, diffs: [] };

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['@tailwindcss/cli', 'canonicalize'], {
      cwd: frontendDir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(
          new Error(`@tailwindcss/cli canonicalize exited with code ${code}: ${stderr}`)
        );
      }

      const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
      const diffs = [];

      for (let i = 0; i < items.length && i < lines.length; i++) {
        const origTokens = items[i].rawClass.split(/\s+/).sort().join(' ');
        const canonTokens = lines[i].split(/\s+/).sort().join(' ');
        if (origTokens !== canonTokens) {
          diffs.push({
            file: items[i].file,
            original: items[i].rawClass,
            canonical: lines[i],
          });
        }
      }

      resolve({ passed: diffs.length === 0, diffs });
    });

    proc.stdin.write(items.map((it) => it.rawClass).join('\n') + '\n');
    proc.stdin.end();
  });
}

import { fileURLToPath } from 'node:url';

// Direct execution from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Checking Tailwind classes for canonicalization...');
  checkCanonicalClasses()
    .then(({ passed, diffs }) => {
      if (!passed) {
        console.error(`\n❌ Found ${diffs.length} non-canonical Tailwind class string(s):`);
        for (const d of diffs) {
          console.error(
            `  [${d.file}]\n    Current:   ${d.original}\n    Canonical: ${d.canonical}`
          );
        }
        process.exit(1);
      }
      console.log('✓ All Tailwind classes are strictly canonical.');
    })
    .catch((err) => {
      console.error('Error running canonicalize check:', err);
      process.exit(1);
    });
}
