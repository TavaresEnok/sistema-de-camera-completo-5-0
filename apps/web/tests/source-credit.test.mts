import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CSS_CREDIT, sourceCreditPlugin, creditedAssetFileNames } from '../build/source-credit.mjs';

test('all generated CSS receives a top comment, preserving rules and vendor notices', () => {
  const css = '/*! Vendor license */\nbody{color:red}';
  const bundle: any = {
    main: { type: 'asset', fileName: 'assets/main.css', source: css },
    vendor: { type: 'asset', fileName: 'assets/vendor.css', source: Buffer.from(css) },
    script: { type: 'chunk', fileName: 'assets/index.js', code: 'unchanged' },
  };
  const plugin = sourceCreditPlugin();
  plugin.generateBundle.handler({}, bundle);
  assert.equal(bundle.main.source, CSS_CREDIT + '\n' + css);
  assert.equal(bundle.vendor.source, CSS_CREDIT + '\n' + css);
  assert.equal(bundle.script.code, 'unchanged');
  plugin.generateBundle.handler({}, bundle);
  assert.equal(bundle.main.source, CSS_CREDIT + '\n' + css);
});

test('CSS cache names change without changing other assets', () => {
  assert.equal(creditedAssetFileNames({ names: ['main.css'] }), 'assets/[name]-[hash]-enok[extname]');
  assert.equal(creditedAssetFileNames({ names: ['logo.svg'] }), 'assets/[name]-[hash][extname]');
});

test('HTML and every owned standalone stylesheet carry a non-visible credit', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.startsWith('<!DOCTYPE html>\n<!-- Feito por by Enok Tavares https://github.com/TavaresEnok/ -->'));
  for (const file of ['../src/index.css', '../public/ajuda/styles.css', '../public/capacidade/styles.css']) {
    assert.ok(readFileSync(new URL(file, import.meta.url), 'utf8').startsWith(CSS_CREDIT), file);
  }
});
